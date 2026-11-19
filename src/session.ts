/**
 * Seam: one Pi session's MCP runtime — configured servers, clients, the six engines, and their
 * lifecycle ordering.
 *
 * Owns config reload reconciliation (attach, reconfigure, reap), probe → `serverReady` fan-out,
 * `serverRemoved` fan-out on detach, branch restore, pre-abort `flushPending`, settle holding,
 * and shutdown. Tool and command handlers call `withServer`, which absorbs waiting on config
 * reloads and probes, capability checks, per-request log collection, and needs-auth error
 * normalization.
 *
 * `src/index.ts` is the declarative Pi wiring layer on top of this module.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildMeta, createServerClient } from "./client.ts";
import { createAuthResolver, loadServerConfigs, shouldConnect } from "./config.ts";
import { runElicitationPrompt } from "./elicitation.ts";
import { createEventsEngine } from "./events.ts";
import { createPromptsEngine, type PromptsEngineApi } from "./prompts.ts";
import { createResourcesEngine, type ResourcesEngineApi } from "./resources.ts";
import { createSkillsEngine, type SkillsEngineApi } from "./skills.ts";
import { createTasksEngine } from "./tasks.ts";
import { cleanupPrivateTempDir } from "./temp-files.ts";
import { createToolsFallback, type ToolsFallbackApi } from "./tools-fallback.ts";
import {
  MESSAGE_EVENT,
  MESSAGE_RESOURCE,
  MESSAGE_TASK,
  McpTransportError,
  PROTOCOL_VERSION,
  type AuthResolver,
  type ConfigLoadOptions,
  type ConfigWarning,
  type DeliveryPreference,
  type EngineHost,
  type EventDescriptor,
  type EventsEngineApi,
  type JsonObject,
  type McpLogLevel,
  type McpLogMessage,
  type ProviderTokenLookup,
  type ResolvedServer,
  type ServerClient,
  type ServerEra,
  type ServerState,
  type TasksEngineApi,
} from "./types.ts";

export type CapabilityKind = "events" | "tasks" | "resources" | "prompts" | "completions" | "skills";

export interface ServerCallRequest {
  server: string;
  /** Required server capability; omitted means "configured, enabled and modern". */
  capability?: CapabilityKind;
  logLevel?: McpLogLevel;
  signal?: AbortSignal;
  /** Latest Pi context (UI availability for elicitation and skill approval). */
  ctx?: ExtensionContext;
}

export interface ServerCallScope {
  client: ServerClient;
  /** Pass to engine calls so request-scoped `notifications/message` frames are collected. */
  logOpts: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void };
}

export interface ServerCallResult<T> {
  value: T;
  /** Formatted request-scoped log lines, in arrival order. */
  logs: string[];
}

/** A `subscribe` entry declared on a server in mcp.json. */
interface DeclaredSubscriptionItem {
  name: string;
  arguments?: JsonObject;
  delivery?: DeliveryPreference;
  maxAgeMs?: number;
  holdSettle?: boolean;
}

/** A resolved server plus its declarative event subscriptions. */
type ConfiguredServerEntry = ResolvedServer & {
  subscribe?: readonly DeclaredSubscriptionItem[];
};

export interface McpSession {
  /** Aborts when the session shuts down. */
  readonly signal: AbortSignal;
  readonly events: EventsEngineApi;
  readonly tasks: TasksEngineApi;
  readonly resources: ResourcesEngineApi;
  readonly prompts: PromptsEngineApi;
  readonly skills: SkillsEngineApi;
  readonly toolsFallback: ToolsFallbackApi;
  /**
   * Wait for pending config reload and the server's probe, require `capability`, run `fn`,
   * and return its value with collected logs. Rejects with a user-facing `Error` for unknown,
   * disabled, legacy, needs-auth, unsupported-version, or capability-missing servers, and
   * normalizes needs-auth transport errors thrown by `fn`.
   */
  withServer<T>(req: ServerCallRequest, fn: (scope: ServerCallScope) => Promise<T>): Promise<ServerCallResult<T>>;
  /**
   * Load config and reconcile clients (serialized; removed/disabled/reconfigured servers are
   * reaped). `ctx`, when given, becomes the session's latest Pi context.
   */
  reconcile(options: ConfigLoadOptions, ctx?: ExtensionContext): Promise<void>;
  /** Restore engines from the active branch (and all entries for cursors/approvals), then refresh the footer. */
  restoreBranch(branch: readonly unknown[], allEntries: readonly unknown[], ctx?: ExtensionContext): void;
  /**
   * Wait until pending config reload, probes, and declarative subscription activations settle
   * (or `signal`/the session aborts).
   */
  ready(signal?: AbortSignal): Promise<void>;
  /**
   * Current state of every configured server, once pending reload, probes, and declarative
   * subscription activations have settled (or `signal`/the session aborts). Refreshes the footer.
   */
  servers(signal?: AbortSignal, ctx?: ExtensionContext): Promise<ServerState[]>;
  /** True while any task is pending or any holdSettle subscription/watch is honored. */
  holdsSettle(): boolean;
  /**
   * Headless settle hold. When a task is pending or a holdSettle subscription/watch is honored,
   * wait until a wake arrives (resolve `true`: the agent should continue), the holds drain, or
   * `ctx.signal`/the session aborts (resolve `false`). Resolves `false` at once when nothing holds
   * or `ctx` already has pending messages.
   */
  settle(ctx: ExtensionContext): Promise<boolean>;
  /** Flush pending wakes, abort, shut every engine and client down, and clean temp files. Idempotent. */
  shutdown(ctx?: ExtensionContext): Promise<void>;
}

/** Footer status key used by this extension. */
const STATUS_KEY = "mcp-ext";

/** `Unknown MCP server "x". Configured servers: a, b.` (or `none`). */
export function unknownServerError(name: string, configured: readonly string[]): Error {
  const names = configured.length > 0 ? configured.join(", ") : "none";
  return new Error(`Unknown MCP server "${name}". Configured servers: ${names}.`);
}

/** Clear this extension's footer status on `ctx` (no-op without UI). */
export function clearMcpStatus(ctx?: ExtensionContext): void {
  if (ctx?.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Format one request-scoped `notifications/message` entry as `[server/logger] (level) text`. */
function formatLogEntry(server: string, entry: McpLogMessage): string {
  const logger = entry.logger ? `/${entry.logger}` : "";
  const text = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data ?? {});
  return `[${server}${logger}] (${entry.level}) ${text}`;
}

function createLogCollector(
  server: string,
  logLevel?: string,
): {
  opts?: { logLevel: McpLogLevel; onLog: (entry: McpLogMessage) => void };
  logs: string[];
} {
  const logs: string[] = [];
  if (!logLevel) return { logs };
  return {
    logs,
    opts: {
      logLevel: logLevel as McpLogLevel,
      onLog: (entry: McpLogMessage) => {
        logs.push(formatLogEntry(server, entry));
      },
    },
  };
}

function formatFooterStatus(taskCount: number, streamCount: number): string | undefined {
  if (taskCount <= 0 && streamCount <= 0) return undefined;
  const taskLabel = taskCount === 1 ? "task" : "tasks";
  const streamLabel = streamCount === 1 ? "stream" : "streams";
  return `mcp: ${taskCount} ${taskLabel} · ${streamCount} ${streamLabel}`;
}

function formatConfigWarning(warning: ConfigWarning): string {
  const scopePrefix = warning.server
    ? `MCP config (${warning.scope}, server "${warning.server}")`
    : `MCP config (${warning.scope})`;
  return `${scopePrefix}: ${warning.message}`;
}

/** Close the client after discover only when the server does not speak MCP 2026-07-28. */
export function shouldKeepConnection(era: ServerEra): boolean {
  return era !== "legacy" && era !== "unsupported-modern-version";
}

function disabledServerState(server: ConfiguredServerEntry): ServerState {
  return {
    name: server.name,
    transport: server.transport,
    era: "disabled",
    events: false,
    eventsListChanged: false,
    tasks: false,
  };
}

/** Rewrite needs-auth transport failures into the user-facing sign-in hint. */
function normalizeServerCallError(serverName: string, err: unknown): Error {
  if (err instanceof McpTransportError && err.kind === "needs-auth") {
    return new Error(`MCP server "${serverName}" requires sign-in; run /mcp login ${serverName}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function raceWithSignals<T>(promise: Promise<T>, signals: readonly (AbortSignal | undefined)[]): Promise<T | undefined> {
  const activeSignals = signals.filter((s): s is AbortSignal => s !== undefined);
  if (activeSignals.some((s) => s.aborted)) {
    return Promise.resolve(undefined);
  }
  if (activeSignals.length === 0) {
    return promise;
  }
  return new Promise<T | undefined>((resolve, reject) => {
    const cleanups: Array<() => void> = [];
    const done = (fn: () => void) => {
      for (const cleanup of cleanups) cleanup();
      fn();
    };
    for (const sig of activeSignals) {
      const onAbort = () => done(() => resolve(undefined));
      sig.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => sig.removeEventListener("abort", onAbort));
    }
    promise.then(
      (val) => done(() => resolve(val)),
      (err) => done(() => reject(err)),
    );
  });
}

function serverTransportKey(server: ConfiguredServerEntry): string {
  const base = {
    enabled: server.enabled,
    timeoutMs: server.timeoutMs,
    exposure: server.exposure ?? null,
    toolExposure: server.toolExposure ?? null,
    description: server.description ?? null,
  };
  if (server.transport === "stdio") {
    return JSON.stringify({
      ...base,
      transport: "stdio",
      command: server.command,
      args: server.args,
      env: Object.entries(server.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      cwd: server.cwd ?? null,
    });
  }
  return JSON.stringify({
    ...base,
    transport: "http",
    url: server.url,
    headers: Object.entries(server.headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    authProvider: server.authProvider ?? null,
    clientCredentials: server.clientCredentials ?? null,
  });
}

export function createMcpSession(pi: ExtensionAPI, ctx: ExtensionContext): McpSession {
  const controller = new AbortController();
  const configuredServers = new Map<string, ConfiguredServerEntry>();
  const clients = new Map<string, ServerClient>();
  /** Probes that were closed because the server does not speak MCP 2026-07-28. Keyed by transport so a reload of the same config does not spawn again. */
  const closedProbes = new Map<string, { key: string; state: ServerState }>();
  const clientCleanups = new Map<string, () => void>();
  const probePromises = new Map<string, Promise<void>>();
  const activationPromises = new Map<string, Promise<void>>();
  const loggedWarnings = new Set<string>();
  const wakeListeners = new Set<() => void>();
  const settleListeners = new Set<() => void>();
  const cleanups: Array<() => void> = [];
  let cwd = ctx.cwd;
  let latestCtx: ExtensionContext | undefined = ctx;
  let configLoadChain: Promise<void> = Promise.resolve();
  let wakeCount = 0;
  let shutdownPromise: Promise<void> | undefined;

  function updateFooter(ctxOverride?: ExtensionContext): void {
    const uiCtx = ctxOverride ?? latestCtx;
    if (!uiCtx?.hasUI) return;
    if (controller.signal.aborted) {
      uiCtx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const taskCount = tasks
      .active()
      .filter((t) => t.status === "working" || t.status === "input_required").length;
    const streamCount = events.activeStreams() + resources.activeWatches();
    uiCtx.ui.setStatus(STATUS_KEY, formatFooterStatus(taskCount, streamCount));
  }

  function notifySettleListeners(): void {
    for (const listener of [...settleListeners]) {
      listener();
    }
  }

  function notifyWakeListeners(): void {
    for (const listener of [...wakeListeners]) {
      listener();
    }
  }

  const host: EngineHost = {
    getClient(server: string): ServerClient | undefined {
      const client = clients.get(server);
      if (!client || client.state.era !== "modern") return undefined;
      return client;
    },
    appendEntry(customType: string, data: unknown): void {
      try {
        pi.appendEntry(customType, data);
      } catch {
        // Session runtime already torn down.
      }
    },
    wake(
      customType: typeof MESSAGE_EVENT | typeof MESSAGE_TASK | typeof MESSAGE_RESOURCE,
      content: string,
      details: unknown,
    ): void {
      if (controller.signal.aborted) return;
      wakeCount += 1;
      pi.sendMessage(
        {
          customType,
          content,
          display: true,
          details,
        },
        {
          triggerTurn: true,
          deliverAs: "steer",
        },
      );
      updateFooter();
      notifyWakeListeners();
      notifySettleListeners();
    },
    log(level: "info" | "warn" | "error", message: string): void {
      updateFooter();
      if (controller.signal.aborted) return;
      const activeCtx = latestCtx;
      if (activeCtx?.hasUI && (level === "warn" || level === "error")) {
        activeCtx.ui.notify(message, level === "warn" ? "warning" : "error");
      }
    },
    async fulfillElicitation(server: string, params: JsonObject) {
      if (controller.signal.aborted) return undefined;
      const activeCtx = latestCtx;
      if (!activeCtx?.hasUI) return undefined;
      return runElicitationPrompt(activeCtx.ui, server, params);
    },
    get signal(): AbortSignal {
      return controller.signal;
    },
  };

  const events: EventsEngineApi = createEventsEngine(host);
  const tasks: TasksEngineApi = createTasksEngine(host);
  const resources: ResourcesEngineApi = createResourcesEngine(host);
  const prompts: PromptsEngineApi = createPromptsEngine(host);
  const skills: SkillsEngineApi = createSkillsEngine(host);
  const toolsFallback: ToolsFallbackApi = createToolsFallback(pi, host, { tasks });

  for (const engine of [events, tasks, resources]) {
    cleanups.push(
      engine.onWake(() => {
        updateFooter();
        notifyWakeListeners();
        notifySettleListeners();
      }),
    );
    if (engine.onStateChange) {
      cleanups.push(
        engine.onStateChange(() => {
          updateFooter();
          notifySettleListeners();
        }),
      );
    }
  }

  async function ensureModernCapability(
    serverName: string,
    capability: CapabilityKind | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ServerClient> {
    await raceWithSignals(configLoadChain, [signal, controller.signal]);
    if (signal?.aborted || controller.signal.aborted) {
      throw new Error(`Operation aborted while waiting for MCP server "${serverName}".`);
    }

    const configured = configuredServers.get(serverName);
    if (!configured) {
      throw unknownServerError(serverName, [...configuredServers.keys()]);
    }
    if (!configured.enabled) {
      throw new Error(`MCP server "${serverName}" is disabled.`);
    }

    const probe = probePromises.get(serverName);
    if (probe) {
      await raceWithSignals(probe, [signal, controller.signal]);
    }
    if (signal?.aborted || controller.signal.aborted) {
      throw new Error(`Operation aborted while probing MCP server "${serverName}".`);
    }

    const client = clients.get(serverName);
    const state = client?.state ?? closedProbes.get(serverName)?.state;
    if (!state) {
      throw new Error(`MCP server "${serverName}" has no active client.`);
    }
    switch (state.era) {
      case "modern": {
        if (!client) {
          throw new Error(`MCP server "${serverName}" has no active client.`);
        }
        if (capability === "events" && !state.events) {
          throw new Error(
            `MCP server "${serverName}" does not advertise io.modelcontextprotocol/events.`,
          );
        }
        if (capability === "tasks" && !state.tasks) {
          throw new Error(
            `MCP server "${serverName}" does not advertise io.modelcontextprotocol/tasks.`,
          );
        }
        if (capability === "resources" && !state.resources) {
          throw new Error(`MCP server "${serverName}" does not advertise resources.`);
        }
        if (capability === "prompts" && !state.prompts) {
          throw new Error(`MCP server "${serverName}" does not advertise prompts.`);
        }
        if (capability === "completions" && !state.completions && !state.prompts && !state.resources) {
          throw new Error(`MCP server "${serverName}" does not advertise completions.`);
        }
        if (capability === "skills" && !state.skills) {
          throw new Error(
            `MCP server "${serverName}" does not advertise both resources and io.modelcontextprotocol/skills.`,
          );
        }
        return client;
      }
      case "needs-auth":
        throw new Error(`MCP server "${serverName}" requires sign-in; run /mcp login ${serverName}`);
      case "modern-dormant":
        throw new Error(
          capability
            ? `MCP server "${serverName}" does not advertise ${capability}.`
            : `MCP server "${serverName}" does not advertise any MCP 2026-07-28 capability.`,
        );
      case "unsupported-modern-version": {
        const supported = state.supportedVersions?.length
          ? ` (supported: ${state.supportedVersions.join(", ")})`
          : "";
        throw new Error(
          `MCP server "${serverName}" does not support MCP protocol version 2026-07-28${supported}.`,
        );
      }
      case "legacy":
        throw new Error(
          `MCP server "${serverName}" speaks legacy MCP (pre-2026-07-28); use its standard MCP tools instead.`,
        );
      case "disabled":
        throw new Error(`MCP server "${serverName}" is disabled.`);
      case "error":
        throw new Error(
          `MCP server "${serverName}" failed discovery${state.error ? `: ${state.error}` : ""}.`,
        );
      case "unknown":
      case "probing":
        throw new Error(`MCP server "${serverName}" has not finished discovery yet.`);
    }
  }

  async function activateDeclaredSubscriptions(
    serverName: string,
    declared: readonly DeclaredSubscriptionItem[],
  ): Promise<void> {
    const signal = controller.signal;
    if (signal.aborted) return;

    let descriptors: EventDescriptor[];
    try {
      descriptors = await events.list(serverName);
    } catch (err) {
      if (!signal.aborted) {
        host.log(
          "warn",
          `MCP server "${serverName}": failed to list events for declarative subscribe: ${errorMessage(err)}`,
        );
      }
      return;
    }
    if (signal.aborted) return;

    const byName = new Map<string, EventDescriptor>();
    for (const descriptor of descriptors) {
      byName.set(descriptor.name, descriptor);
    }

    const supportsClientDelivery = (descriptor: EventDescriptor): boolean =>
      descriptor.delivery.includes("push") || descriptor.delivery.includes("poll");

    const tasksToRun: Array<Promise<void>> = [];
    const queueSub = (
      name: string,
      item: DeclaredSubscriptionItem,
      delivery: DeliveryPreference,
      holdSettle: boolean,
    ): void => {
      tasksToRun.push(
        events
          .subscribe({
            server: serverName,
            name,
            ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
            delivery,
            cursor: undefined,
            ...(item.maxAgeMs !== undefined ? { maxAgeMs: item.maxAgeMs } : {}),
            holdSettle,
          })
          .then(() => undefined)
          .catch((err) => {
            if (!signal.aborted) {
              host.log(
                "warn",
                `MCP server "${serverName}": failed to subscribe to "${name}": ${errorMessage(err)}`,
              );
            }
          }),
      );
    };

    for (const item of declared) {
      if (signal.aborted) return;
      const delivery: DeliveryPreference = item.delivery ?? "auto";
      const holdSettle = item.holdSettle ?? false;

      if (item.name === "*") {
        for (const descriptor of descriptors) {
          if (signal.aborted) return;
          if (!supportsClientDelivery(descriptor)) continue;
          queueSub(descriptor.name, item, delivery, holdSettle);
        }
        continue;
      }

      const descriptor = byName.get(item.name);
      if (!descriptor) {
        host.log(
          "warn",
          `MCP server "${serverName}": declared event "${item.name}" was not found in events/list; skipping.`,
        );
        continue;
      }

      if (!supportsClientDelivery(descriptor)) {
        host.log(
          "warn",
          `MCP server "${serverName}": declared event "${item.name}" only supports webhook delivery; skipping.`,
        );
        continue;
      }

      queueSub(item.name, item, delivery, holdSettle);
    }

    if (tasksToRun.length > 0) {
      await Promise.all(tasksToRun);
    }
  }

  function scheduleDeclaredActivation(
    server: ConfiguredServerEntry,
    client: ServerClient,
    basePromise: Promise<void>,
  ): void {
    if (!server.subscribe || server.subscribe.length === 0) return;
    const signal = controller.signal;
    const declared = server.subscribe;
    const activationPromise = basePromise
      .then(async () => {
        if (signal.aborted) return;
        const state = client.state;
        if (state.era !== "modern" || !state.events) return;
        await activateDeclaredSubscriptions(server.name, declared);
        updateFooter();
      })
      .finally(() => {
        if (activationPromises.get(server.name) === activationPromise) {
          activationPromises.delete(server.name);
        }
      });
    activationPromises.set(server.name, activationPromise);
  }

  function startServerProbe(server: ConfiguredServerEntry, client: ServerClient): void {
    const signal = controller.signal;
    const probePromise = (async (): Promise<void> => {
      try {
        const state = await client.discover();
        if (signal.aborted) return;
        updateFooter();
        if (!shouldKeepConnection(state.era)) {
          if (clients.get(server.name) === client) {
            const key = serverTransportKey(server);
            await detachClient(server.name);
            const still = configuredServers.get(server.name);
            if (still && shouldConnect(still) && serverTransportKey(still) === key) {
              closedProbes.set(server.name, { key, state: { ...state } });
            }
          }
          return;
        }
        if (state.era !== "modern") return;
        if (state.events) {
          events.serverReady(server.name);
        }
        if (state.tasks) {
          tasks.serverReady(server.name);
        }
        if (state.resources) {
          resources.serverReady(server.name);
        }
        if (state.prompts) {
          await prompts.serverReady(server.name).catch((err) => {
            if (!signal.aborted) {
              host.log(
                "warn",
                `MCP server "${server.name}" prompts discovery failed: ${errorMessage(err)}`,
              );
            }
          });
        }
        let tookToolsFallback = false;
        if (state.tools) {
          tookToolsFallback = await toolsFallback.activateIfUnowned(server);
        }
        // Park idle stdio transport whenever no standing stream/listen interest is active;
        // client.park() checks desiredKey === "{}", inFlightCount === 0, and openUserStreams === 0.
        if (!tookToolsFallback) {
          await client.park?.();
        }
        updateFooter();
      } catch (err) {
        if (!signal.aborted) {
          host.log(
            "warn",
            `MCP server "${server.name}" discovery failed: ${errorMessage(err)}`,
          );
        }
      }
    })();

    probePromises.set(server.name, probePromise);
    scheduleDeclaredActivation(server, client, probePromise);
  }

  async function detachClient(name: string): Promise<void> {
    toolsFallback.deactivateServer(name);
    events.serverRemoved?.(name);
    tasks.serverRemoved?.(name);
    resources.serverRemoved?.(name);
    prompts.serverRemoved?.(name);
    clientCleanups.get(name)?.();
    clientCleanups.delete(name);
    probePromises.delete(name);
    activationPromises.delete(name);
    const client = clients.get(name);
    clients.delete(name);
    if (client) {
      await client.close().catch(() => {});
    }
  }

  async function reconcileConfiguredServers(
    servers: readonly ConfiguredServerEntry[],
    warnings: readonly ConfigWarning[],
  ): Promise<void> {
    if (controller.signal.aborted) return;

    for (const warning of warnings) {
      const formatted = formatConfigWarning(warning);
      if (!loggedWarnings.has(formatted)) {
        loggedWarnings.add(formatted);
        host.log("warn", formatted);
      }
    }

    const nextByName = new Map<string, ConfiguredServerEntry>();
    for (const server of servers) {
      nextByName.set(server.name, server);
    }

    // Close and remove clients whose server was deleted, disabled, or reconfigured.
    const detachTasks: Array<Promise<void>> = [];
    for (const [name, oldCfg] of [...configuredServers.entries()]) {
      const nextCfg = nextByName.get(name);
      if (!nextCfg || !shouldConnect(nextCfg)) {
        configuredServers.delete(name);
        closedProbes.delete(name);
        if (clients.has(name)) detachTasks.push(detachClient(name));
        continue;
      }
      const keyChanged = serverTransportKey(oldCfg) !== serverTransportKey(nextCfg);
      if (!nextCfg.enabled || keyChanged) {
        closedProbes.delete(name);
        if (clients.has(name)) detachTasks.push(detachClient(name));
      }
    }
    if (detachTasks.length > 0) {
      await Promise.allSettled(detachTasks);
    }
    if (controller.signal.aborted) return;

    const providerToken: ProviderTokenLookup = async (
      provider: string,
    ): Promise<string | undefined> => {
      const activeCtx = latestCtx;
      if (!activeCtx) return undefined;
      try {
        const resolved = await activeCtx.modelRegistry.getProviderAuth(provider);
        return resolved?.auth.apiKey;
      } catch {
        return undefined;
      }
    };

    for (const server of servers) {
      if (!shouldConnect(server)) continue;

      const prevCfg = configuredServers.get(server.name);
      configuredServers.set(server.name, server);

      if (!server.enabled) {
        continue;
      }

      if (clients.has(server.name)) {
        closedProbes.delete(server.name);
      } else {
        const prior = closedProbes.get(server.name);
        if (prior?.key === serverTransportKey(server)) continue;
        closedProbes.delete(server.name);
      }

      const existingClient = clients.get(server.name);
      if (existingClient) {
        if (
          server.subscribe &&
          server.subscribe.length > 0 &&
          JSON.stringify(prevCfg?.subscribe ?? []) !== JSON.stringify(server.subscribe)
        ) {
          const probe = probePromises.get(server.name) ?? Promise.resolve();
          scheduleDeclaredActivation(server, existingClient, probe);
        }
        continue;
      }

      const auth: AuthResolver | undefined =
        server.transport === "http" ? createAuthResolver(server, providerToken) : undefined;

      const client: ServerClient = createServerClient(server, {
        cwd,
        ...(auth ? { auth } : {}),
        meta: () =>
          buildMeta({
            skills: true,
            elicitation: Boolean(latestCtx?.hasUI),
            oauthClientCredentials: server.transport === "http" && Boolean(server.clientCredentials),
            traceContext: process.env,
          }),
        autoParkIdleStdio: () => Boolean(client.state.supportedVersions?.some((v) => v < PROTOCOL_VERSION)),
        fulfillInputRequests: async (srvName, inputRequests) => {
          if (!host.fulfillElicitation || !latestCtx?.hasUI) return undefined;
          const responses: JsonObject = {};
          for (const [reqKey, reqItem] of Object.entries(inputRequests)) {
            if (reqItem.method !== "elicitation/create") {
              return undefined;
            }
            const out = await host.fulfillElicitation(srvName, reqItem.params ?? {});
            if (!out) return undefined;
            responses[reqKey] = out as unknown as JsonObject;
          }
          return responses;
        },
        log: (level: "info" | "warn" | "error", msg: string) => {
          host.log(level, msg);
        },
      });

      clients.set(server.name, client);
      const offListen = client.onListenState(() => {
        updateFooter();
      });
      clientCleanups.set(server.name, offListen);

      startServerProbe(server, client);
    }
  }

  function queueConfigReload(options: ConfigLoadOptions): Promise<void> {
    const next = configLoadChain.then(async () => {
      if (controller.signal.aborted) return;
      const loaded: { servers: ConfiguredServerEntry[]; warnings: ConfigWarning[] } =
        await loadServerConfigs(options);
      if (controller.signal.aborted) return;
      await reconcileConfiguredServers(loaded.servers, loaded.warnings);
      updateFooter();
    });
    configLoadChain = next.catch(() => undefined);
    return next;
  }

  async function waitForReload(signal?: AbortSignal): Promise<void> {
    await raceWithSignals(configLoadChain, [signal, controller.signal]);
  }

  async function waitForProbesAndActivations(signal?: AbortSignal): Promise<void> {
    if (probePromises.size > 0) {
      await raceWithSignals(Promise.allSettled([...probePromises.values()]), [signal, controller.signal]);
    }
    if (activationPromises.size > 0) {
      await raceWithSignals(Promise.allSettled([...activationPromises.values()]), [signal, controller.signal]);
    }
  }

  function settle(ctxArg: ExtensionContext): Promise<boolean> {
    latestCtx = ctxArg;
    return (async (): Promise<boolean> => {
      await waitForReload(ctxArg.signal);
      await waitForProbesAndActivations(ctxArg.signal);
      if (ctxArg.signal?.aborted || controller.signal.aborted) return false;
      if (!session.holdsSettle() || ctxArg.hasPendingMessages()) return false;

      const startWakeCount = wakeCount;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const offs: Array<() => void> = [];
        const finish = (woke: boolean) => {
          if (settled) return;
          settled = true;
          for (const off of offs) off();
          resolve(woke);
        };
        const evaluate = () => {
          if (controller.signal.aborted || ctxArg.signal?.aborted) return finish(false);
          if (wakeCount !== startWakeCount || ctxArg.hasPendingMessages()) return finish(true);
          if (!session.holdsSettle()) finish(false);
        };

        const onWake = () => finish(true);
        wakeListeners.add(onWake);
        offs.push(() => wakeListeners.delete(onWake));
        settleListeners.add(evaluate);
        offs.push(() => settleListeners.delete(evaluate));
        for (const sig of [controller.signal, ctxArg.signal]) {
          if (!sig) continue;
          if (sig.aborted) return finish(false);
          const onAbort = () => finish(false);
          sig.addEventListener("abort", onAbort, { once: true });
          offs.push(() => sig.removeEventListener("abort", onAbort));
        }
        evaluate();
      });
    })();
  }

  function shutdownSession(ctxArg?: ExtensionContext): Promise<void> {
    if (shutdownPromise) {
      clearMcpStatus(ctxArg);
      return shutdownPromise;
    }

    shutdownPromise = (async (): Promise<void> => {
      // Flush coalesced event/resource batches while wake() is still live so cursors commit after delivery.
      events.flushPending?.();
      resources.flushPending?.();
      controller.abort();
      const uiCtx = ctxArg ?? latestCtx;
      clearMcpStatus(uiCtx);

      for (const off of clientCleanups.values()) {
        try {
          off();
        } catch {
          // Ignore listener cleanup errors.
        }
      }
      clientCleanups.clear();
      const pending = cleanups.splice(0, cleanups.length);
      for (const cleanup of pending) {
        try {
          cleanup();
        } catch {
          // Ignore listener cleanup errors.
        }
      }
      wakeListeners.clear();
      settleListeners.clear();

      await Promise.allSettled([
        events.shutdown(),
        tasks.shutdown(),
        resources.shutdown(),
        prompts.shutdown(),
        skills.shutdown(),
        toolsFallback.shutdown(),
      ]);
      await Promise.allSettled(
        [...clients.values()].map((client: ServerClient) => client.close()),
      );
      clients.clear();
      probePromises.clear();
      activationPromises.clear();
      cleanupPrivateTempDir();

      clearMcpStatus(uiCtx);
    })();

    return shutdownPromise;
  }

  const session: McpSession = {
    get signal(): AbortSignal {
      return controller.signal;
    },
    events,
    tasks,
    resources,
    prompts,
    skills,
    toolsFallback,

    async withServer<T>(
      req: ServerCallRequest,
      fn: (scope: ServerCallScope) => Promise<T>,
    ): Promise<ServerCallResult<T>> {
      if (req.ctx) latestCtx = req.ctx;
      const client = await ensureModernCapability(req.server, req.capability, req.signal);
      const collector = createLogCollector(req.server, req.logLevel);
      try {
        const value = await fn({ client, logOpts: collector.opts ?? {} });
        return { value, logs: collector.logs };
      } catch (err) {
        throw normalizeServerCallError(req.server, err);
      } finally {
        updateFooter(req.ctx);
      }
    },

    reconcile(options: ConfigLoadOptions, ctxArg?: ExtensionContext): Promise<void> {
      cwd = options.cwd;
      if (ctxArg) latestCtx = ctxArg;
      return queueConfigReload(options);
    },

    restoreBranch(branch: readonly unknown[], allEntries: readonly unknown[], ctxArg?: ExtensionContext): void {
      if (ctxArg) latestCtx = ctxArg;
      events.restore(branch, allEntries);
      tasks.restore(branch);
      resources.restore(branch);
      skills.restore(allEntries);
      updateFooter(ctxArg);
    },

    async ready(signal?: AbortSignal): Promise<void> {
      await waitForReload(signal);
      await waitForProbesAndActivations(signal);
    },

    async servers(signal?: AbortSignal, ctxArg?: ExtensionContext): Promise<ServerState[]> {
      if (ctxArg) latestCtx = ctxArg;
      await waitForReload(signal);
      await waitForProbesAndActivations(signal);
      const states: ServerState[] = [];
      for (const [name, cfg] of configuredServers) {
        const client = clients.get(name);
        const retired = closedProbes.get(name)?.state;
        states.push(client ? { ...client.state } : retired ? { ...retired } : disabledServerState(cfg));
      }
      updateFooter(ctxArg);
      return states;
    },

    holdsSettle(): boolean {
      return tasks.hasPending() || events.holdsSettle() || resources.holdsSettle();
    },

    settle,

    shutdown(ctxArg?: ExtensionContext): Promise<void> {
      return shutdownSession(ctxArg);
    },
  };

  return session;
}
