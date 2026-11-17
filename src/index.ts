/**
 * Pi extension entry for @jangmanj/pi-mcp-ext.
 *
 * Runs alongside builtin:mcp without replacing /mcp or registering built-in MCP tool names.
 * Registers mcp_events, mcp_tasks, message renderers, and session lifecycle handlers.
 */

import { StringEnum, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  MessageRenderOptions,
  MessageRenderer,
  RegisteredMcpServer,
  Theme,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type, type Static, type TUnsafe } from "typebox";

import { buildMeta, createServerClient } from "./client.ts";
import { createAuthResolver, loadServerConfigs } from "./config.ts";
import { runElicitationPrompt } from "./elicitation.ts";
import { createEventsEngine } from "./events.ts";
import {
  createPromptsEngine,
  parseSlashPromptInput,
  type PromptDescriptor,
  type PromptsEngineApi,
} from "./prompts.ts";
import { createResourcesEngine, type ResourcesEngineApi } from "./resources.ts";
import { createSkillsEngine, type SkillsEngineApi } from "./skills.ts";
import { createTasksEngine } from "./tasks.ts";
import { cleanupPrivateTempDir } from "./temp-files.ts";
import { createToolsFallback, type ToolsFallbackApi } from "./tools-fallback.ts";
import {
  EXT_TASKS,
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
  type PollEventsParams,
  type ProviderTokenLookup,
  type ResolvedServer,
  type ServerClient,
  type ServerState,
  type SubscribeRequest,
  type TasksEngineApi,
} from "./types.ts";

const STATUS_KEY = "mcp-ext";

interface DeclaredSubscriptionItem {
  name: string;
  arguments?: JsonObject;
  delivery?: DeliveryPreference;
  maxAgeMs?: number;
  holdSettle?: boolean;
}

type ConfiguredServerEntry = ResolvedServer & {
  subscribe?: readonly DeclaredSubscriptionItem[];
};

interface SessionRuntime {
  readonly controller: AbortController;
  cwd: string;
  latestCtx: ExtensionContext | undefined;
  readonly host: EngineHost;
  readonly events: EventsEngineApi;
  readonly tasks: TasksEngineApi;
  readonly resources: ResourcesEngineApi;
  readonly prompts: PromptsEngineApi;
  readonly skills: SkillsEngineApi;
  readonly toolsFallback: ToolsFallbackApi;
  readonly configuredServers: Map<string, ConfiguredServerEntry>;
  readonly clients: Map<string, ServerClient>;
  readonly clientCleanups: Map<string, () => void>;
  readonly probePromises: Map<string, Promise<void>>;
  readonly activationPromises: Map<string, Promise<void>>;
  readonly loggedWarnings: Set<string>;
  readonly wakeListeners: Set<() => void>;
  readonly settleListeners: Set<() => void>;
  readonly cleanups: Array<() => void>;
  configLoadChain: Promise<void>;
  wakeCount: number;
  shutdownPromise: Promise<void> | undefined;
}

function stringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>(StringEnum(values, options));
}

const McpEventsParams = Type.Object(
  {
    action: stringEnum(["servers", "list", "subscribe", "unsubscribe", "subscriptions", "poll"], {
      description: "Events operation to perform.",
    }),
    server: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Target MCP server name (required for list, subscribe, unsubscribe, poll).",
      }),
    ),
    name: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Event type name (required for subscribe, unsubscribe, poll).",
      }),
    ),
    arguments: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Subscription filter or event arguments.",
      }),
    ),
    delivery: Type.Optional(
      stringEnum(["auto", "push", "poll"], {
        description: "Delivery mode preference (default: auto).",
      }),
    ),
    cursor: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: "Starting cursor (null starts from now; omit to use persisted cursor).",
      }),
    ),
    maxAgeMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Replay age limit in integer milliseconds.",
      }),
    ),
    maxEvents: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum events to return in a single poll batch.",
      }),
    ),
    holdSettle: Type.Optional(
      Type.Boolean({
        description:
          "Hold print/json settlement open until an event arrives or unsubscribe is called.",
      }),
    ),
    logLevel: Type.Optional(
      stringEnum(
        ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"],
        {
          description:
            "Per-request MCP log level (SEP-2575 io.modelcontextprotocol/logLevel) for list/poll.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

type McpEventsInput = Static<typeof McpEventsParams>;

const McpTasksParams = Type.Object(
  {
    action: stringEnum(["call", "get", "update", "cancel", "active"], {
      description: "Task operation to perform.",
    }),
    server: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Target MCP server name (required for call, get, update, cancel).",
      }),
    ),
    tool: Type.Optional(
      Type.String({
        minLength: 1,
        description: "MCP tool name on the server (required for call).",
      }),
    ),
    arguments: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Tool call arguments for action 'call'.",
      }),
    ),
    taskId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Task identifier (required for get, update, cancel).",
      }),
    ),
    inputResponses: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Responses keyed by inputRequests identifier (for action 'update').",
      }),
    ),
    logLevel: Type.Optional(
      stringEnum(
        ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"],
        {
          description:
            "Per-request MCP log level (SEP-2575 io.modelcontextprotocol/logLevel) for call/get/update/cancel.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

type McpTasksInput = Static<typeof McpTasksParams>;

const LOG_LEVEL_SCHEMA = Type.Optional(
  stringEnum(
    ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"],
    {
      description:
        "Per-request MCP log level (SEP-2575 io.modelcontextprotocol/logLevel).",
    },
  ),
);

const McpResourcesParams = Type.Object(
  {
    action: stringEnum(
      ["list", "templates", "read", "directory", "subscribe", "unsubscribe", "subscriptions"],
      { description: "Resource or resource-subscription operation to perform." },
    ),
    server: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Target MCP server name (required except for 'subscriptions').",
      }),
    ),
    uri: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Resource or directory URI (required for read, directory, subscribe, unsubscribe).",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        description: "Pagination cursor for list, templates, or directory.",
      }),
    ),
    holdSettle: Type.Optional(
      Type.Boolean({
        description: "Hold headless print/json runs open while this resource watch is active.",
      }),
    ),
    logLevel: LOG_LEVEL_SCHEMA,
  },
  { additionalProperties: false },
);

type McpResourcesInput = Static<typeof McpResourcesParams>;

const McpPromptsParams = Type.Object(
  {
    action: stringEnum(["list", "get", "complete"], {
      description: "Prompt discovery, retrieval, or argument completion.",
    }),
    server: Type.String({
      minLength: 1,
      description: "Target MCP server name.",
    }),
    name: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Prompt name (required for get, or complete with refType='prompt').",
      }),
    ),
    uri: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Resource URI or template (for complete with refType='resource').",
      }),
    ),
    refType: Type.Optional(
      stringEnum(["prompt", "resource"], {
        description: "Completion reference type (default: 'prompt', or 'resource' when uri is given).",
      }),
    ),
    arguments: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: "Prompt arguments for 'get', or already-resolved context.arguments for 'complete'.",
      }),
    ),
    argumentName: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Argument name being completed (required for 'complete').",
      }),
    ),
    argumentValue: Type.Optional(
      Type.String({
        description: "Current partial argument value (for 'complete', default '').",
      }),
    ),
    logLevel: LOG_LEVEL_SCHEMA,
  },
  { additionalProperties: false },
);

type McpPromptsInput = Static<typeof McpPromptsParams>;

const McpSkillsParams = Type.Object(
  {
    action: stringEnum(["list", "get", "load", "read_file", "directory"], {
      description: "Skills over MCP (io.modelcontextprotocol/skills) operation.",
    }),
    server: Type.String({
      minLength: 1,
      description: "Target MCP server name.",
    }),
    uri: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Skill SKILL.md URI (required for get, load, read_file) or directory URI (for directory).",
      }),
    ),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Relative path or URI inside the retained skill manifest (required for read_file).",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        description: "Pagination cursor for action 'directory'.",
      }),
    ),
    logLevel: LOG_LEVEL_SCHEMA,
  },
  { additionalProperties: false },
);

type McpSkillsInput = Static<typeof McpSkillsParams>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function jsonResult<T>(data: T, logs?: readonly string[]): AgentToolResult<T> {
  const content: TextContent[] = [{ type: "text", text: JSON.stringify(data, null, 2) }];
  if (logs && logs.length > 0) {
    content.push({ type: "text", text: logs.join("\n") });
  }
  return {
    content,
    details: data,
  };
}

function toSessionServers(
  entries: readonly RegisteredMcpServer[],
): Array<{ name: string; config: JsonObject }> {
  return entries.map((entry: RegisteredMcpServer) => ({
    name: entry.name,
    config: { ...(entry.config as unknown as JsonObject) },
  }));
}

function formatFooterStatus(taskCount: number, streamCount: number): string | undefined {
  if (taskCount <= 0 && streamCount <= 0) return undefined;
  const taskLabel = taskCount === 1 ? "task" : "tasks";
  const streamLabel = streamCount === 1 ? "stream" : "streams";
  return `mcp: ${taskCount} ${taskLabel} · ${streamCount} ${streamLabel}`;
}

function updateFooter(session: SessionRuntime | undefined, ctxOverride?: ExtensionContext): void {
  const ctx = ctxOverride ?? session?.latestCtx;
  if (!ctx?.hasUI) return;
  if (!session || session.controller.signal.aborted) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const taskCount = session.tasks
    .active()
    .filter((t) => t.status === "working" || t.status === "input_required").length;
  const streamCount = session.events.activeStreams() + session.resources.activeWatches();
  ctx.ui.setStatus(STATUS_KEY, formatFooterStatus(taskCount, streamCount));
}

function formatConfigWarning(warning: ConfigWarning): string {
  const scopePrefix = warning.server
    ? `MCP config (${warning.scope}, server "${warning.server}")`
    : `MCP config (${warning.scope})`;
  return `${scopePrefix}: ${warning.message}`;
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

function configuredNamesList(session: SessionRuntime): string {
  const names = [...session.configuredServers.keys()];
  return names.length > 0 ? names.join(", ") : "none";
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

async function ensureModernCapability(
  session: SessionRuntime,
  serverName: string,
  capability: "events" | "tasks" | "resources" | "prompts" | "completions" | "skills",
  signal: AbortSignal | undefined,
): Promise<ServerClient> {
  await raceWithSignals(session.configLoadChain, [signal, session.controller.signal]);
  if (signal?.aborted || session.controller.signal.aborted) {
    throw new Error(`Operation aborted while waiting for MCP server "${serverName}".`);
  }

  const configured = session.configuredServers.get(serverName);
  if (!configured) {
    throw new Error(
      `Unknown MCP server "${serverName}". Configured servers: ${configuredNamesList(session)}.`,
    );
  }
  if (!configured.enabled) {
    throw new Error(`MCP server "${serverName}" is disabled.`);
  }

  const probe = session.probePromises.get(serverName);
  if (probe) {
    await raceWithSignals(probe, [signal, session.controller.signal]);
  }
  if (signal?.aborted || session.controller.signal.aborted) {
    throw new Error(`Operation aborted while probing MCP server "${serverName}".`);
  }

  const client = session.clients.get(serverName);
  if (!client) {
    throw new Error(`MCP server "${serverName}" has no active client.`);
  }

  const state = client.state;
  switch (state.era) {
    case "modern": {
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
        `MCP server "${serverName}" does not advertise ${capability}.`,
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

function normalizeServerCallError(serverName: string, err: unknown): Error {
  if (err instanceof McpTransportError && err.kind === "needs-auth") {
    return new Error(`MCP server "${serverName}" requires sign-in; run /mcp login ${serverName}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function activateDeclaredSubscriptions(
  session: SessionRuntime,
  serverName: string,
  declared: readonly DeclaredSubscriptionItem[],
): Promise<void> {
  const signal = session.controller.signal;
  if (signal.aborted) return;

  let descriptors: EventDescriptor[];
  try {
    descriptors = await session.events.list(serverName);
  } catch (err) {
    if (!signal.aborted) {
      session.host.log(
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
      session.events
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
            session.host.log(
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
      session.host.log(
        "warn",
        `MCP server "${serverName}": declared event "${item.name}" was not found in events/list; skipping.`,
      );
      continue;
    }

    if (!supportsClientDelivery(descriptor)) {
      session.host.log(
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

function scheduleDeclaredActivation(
  session: SessionRuntime,
  server: ConfiguredServerEntry,
  client: ServerClient,
  basePromise: Promise<void>,
): void {
  if (!server.subscribe || server.subscribe.length === 0) return;
  const signal = session.controller.signal;
  const declared = server.subscribe;
  const activationPromise = basePromise
    .then(async () => {
      if (signal.aborted) return;
      const state = client.state;
      if (state.era !== "modern" || !state.events) return;
      await activateDeclaredSubscriptions(session, server.name, declared);
      updateFooter(session);
    })
    .finally(() => {
      if (session.activationPromises.get(server.name) === activationPromise) {
        session.activationPromises.delete(server.name);
      }
    });
  session.activationPromises.set(server.name, activationPromise);
}

function startServerProbe(
  session: SessionRuntime,
  server: ConfiguredServerEntry,
  client: ServerClient,
): void {
  const signal = session.controller.signal;
  const probePromise = (async (): Promise<void> => {
    try {
      const state = await client.discover();
      if (signal.aborted) return;
      updateFooter(session);
      if (state.era !== "modern") return;
      if (state.events) {
        session.events.serverReady(server.name);
      }
      if (state.tasks) {
        session.tasks.serverReady(server.name);
      }
      if (state.resources) {
        session.resources.serverReady(server.name);
      }
      if (state.prompts) {
        await session.prompts.serverReady(server.name).catch((err) => {
          if (!signal.aborted) {
            session.host.log(
              "warn",
              `MCP server "${server.name}" prompts discovery failed: ${errorMessage(err)}`,
            );
          }
        });
      }
      let tookToolsFallback = false;
      if (state.tools) {
        tookToolsFallback = await session.toolsFallback.activateIfUnowned(server);
      }
      // Park idle stdio transport whenever no standing stream/listen interest is active;
      // client.park() checks desiredKey === "{}", inFlightCount === 0, and openUserStreams === 0.
      if (!tookToolsFallback) {
        await client.park?.();
      }
      updateFooter(session);
    } catch (err) {
      if (!signal.aborted) {
        session.host.log(
          "warn",
          `MCP server "${server.name}" discovery failed: ${errorMessage(err)}`,
        );
      }
    }
  })();

  session.probePromises.set(server.name, probePromise);
  scheduleDeclaredActivation(session, server, client, probePromise);
}

async function detachClient(session: SessionRuntime, name: string): Promise<void> {
  session.toolsFallback.deactivateServer(name);
  session.events.serverRemoved?.(name);
  session.tasks.serverRemoved?.(name);
  session.resources.serverRemoved?.(name);
  session.prompts.serverRemoved?.(name);
  session.clientCleanups.get(name)?.();
  session.clientCleanups.delete(name);
  session.probePromises.delete(name);
  session.activationPromises.delete(name);
  const client = session.clients.get(name);
  session.clients.delete(name);
  if (client) {
    await client.close().catch(() => {});
  }
}

async function reconcileConfiguredServers(
  session: SessionRuntime,
  servers: readonly ConfiguredServerEntry[],
  warnings: readonly ConfigWarning[],
): Promise<void> {
  if (session.controller.signal.aborted) return;

  for (const warning of warnings) {
    const formatted = formatConfigWarning(warning);
    if (!session.loggedWarnings.has(formatted)) {
      session.loggedWarnings.add(formatted);
      session.host.log("warn", formatted);
    }
  }

  const nextByName = new Map<string, ConfiguredServerEntry>();
  for (const server of servers) {
    nextByName.set(server.name, server);
  }

  // Close and remove clients whose server was deleted, disabled, or reconfigured.
  const detachTasks: Array<Promise<void>> = [];
  for (const [name, oldCfg] of [...session.configuredServers.entries()]) {
    const nextCfg = nextByName.get(name);
    if (!nextCfg) {
      session.configuredServers.delete(name);
      if (session.clients.has(name)) {
        detachTasks.push(detachClient(session, name));
      }
      continue;
    }
    if (
      session.clients.has(name) &&
      (!nextCfg.enabled || serverTransportKey(oldCfg) !== serverTransportKey(nextCfg))
    ) {
      detachTasks.push(detachClient(session, name));
    }
  }
  if (detachTasks.length > 0) {
    await Promise.allSettled(detachTasks);
  }
  if (session.controller.signal.aborted) return;

  const providerToken: ProviderTokenLookup = async (
    provider: string,
  ): Promise<string | undefined> => {
    const activeCtx = session.latestCtx;
    if (!activeCtx) return undefined;
    try {
      const resolved = await activeCtx.modelRegistry.getProviderAuth(provider);
      return resolved?.auth.apiKey;
    } catch {
      return undefined;
    }
  };

  for (const server of servers) {
    const prevCfg = session.configuredServers.get(server.name);
    session.configuredServers.set(server.name, server);

    if (!server.enabled) {
      continue;
    }

    const existingClient = session.clients.get(server.name);
    if (existingClient) {
      if (
        server.subscribe &&
        server.subscribe.length > 0 &&
        JSON.stringify(prevCfg?.subscribe ?? []) !== JSON.stringify(server.subscribe)
      ) {
        const probe = session.probePromises.get(server.name) ?? Promise.resolve();
        scheduleDeclaredActivation(session, server, existingClient, probe);
      }
      continue;
    }

    const auth: AuthResolver | undefined =
      server.transport === "http" ? createAuthResolver(server, providerToken) : undefined;

    const client: ServerClient = createServerClient(server, {
      cwd: session.cwd,
      ...(auth ? { auth } : {}),
      meta: () =>
        buildMeta({
          skills: true,
          elicitation: Boolean(session.latestCtx?.hasUI),
          oauthClientCredentials: server.transport === "http" && Boolean(server.clientCredentials),
          traceContext: process.env,
        }),
      autoParkIdleStdio: () => Boolean(client.state.supportedVersions?.some((v) => v < PROTOCOL_VERSION)),
      fulfillInputRequests: async (srvName, inputRequests) => {
        if (!session.host.fulfillElicitation || !session.latestCtx?.hasUI) return undefined;
        const responses: JsonObject = {};
        for (const [reqKey, reqItem] of Object.entries(inputRequests)) {
          if (reqItem.method !== "elicitation/create") {
            return undefined;
          }
          const out = await session.host.fulfillElicitation(srvName, reqItem.params ?? {});
          if (!out) return undefined;
          responses[reqKey] = out as unknown as JsonObject;
        }
        return responses;
      },
      log: (level: "info" | "warn" | "error", msg: string) => {
        session.host.log(level, msg);
      },
    });

    session.clients.set(server.name, client);
    const offListen = client.onListenState(() => {
      updateFooter(session);
    });
    session.clientCleanups.set(server.name, offListen);

    startServerProbe(session, server, client);
  }
}

function queueConfigReload(
  session: SessionRuntime,
  options: ConfigLoadOptions,
): Promise<void> {
  const next = session.configLoadChain.then(async () => {
    if (session.controller.signal.aborted) return;
    const loaded: { servers: ConfiguredServerEntry[]; warnings: ConfigWarning[] } =
      await loadServerConfigs(options);
    if (session.controller.signal.aborted) return;
    await reconcileConfiguredServers(session, loaded.servers, loaded.warnings);
    updateFooter(session);
  });
  session.configLoadChain = next.catch(() => undefined);
  return next;
}

function notifySettleListeners(session: SessionRuntime | undefined): void {
  if (!session) return;
  for (const listener of [...session.settleListeners]) {
    listener();
  }
}

function createSessionRuntime(pi: ExtensionAPI, ctx: ExtensionContext): SessionRuntime {
  const controller = new AbortController();
  const configuredServers = new Map<string, ConfiguredServerEntry>();
  const clients = new Map<string, ServerClient>();
  const clientCleanups = new Map<string, () => void>();
  const probePromises = new Map<string, Promise<void>>();
  const activationPromises = new Map<string, Promise<void>>();
  const loggedWarnings = new Set<string>();
  const wakeListeners = new Set<() => void>();
  const settleListeners = new Set<() => void>();
  const cleanups: Array<() => void> = [];

  let runtimeRef: SessionRuntime | undefined;

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
      if (runtimeRef) {
        runtimeRef.wakeCount += 1;
      }
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
      updateFooter(runtimeRef);
      for (const listener of [...wakeListeners]) {
        listener();
      }
      notifySettleListeners(runtimeRef);
    },
    log(level: "info" | "warn" | "error", message: string): void {
      updateFooter(runtimeRef);
      if (controller.signal.aborted) return;
      const activeCtx = runtimeRef?.latestCtx;
      if (activeCtx?.hasUI && (level === "warn" || level === "error")) {
        activeCtx.ui.notify(message, level === "warn" ? "warning" : "error");
      }
    },
    async fulfillElicitation(server: string, params: JsonObject) {
      if (controller.signal.aborted) return undefined;
      const activeCtx = runtimeRef?.latestCtx;
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

  const session: SessionRuntime = {
    controller,
    cwd: ctx.cwd,
    latestCtx: ctx,
    host,
    events,
    tasks,
    resources,
    prompts,
    skills,
    toolsFallback,
    configuredServers,
    clients,
    clientCleanups,
    probePromises,
    activationPromises,
    loggedWarnings,
    wakeListeners,
    settleListeners,
    cleanups,
    configLoadChain: Promise.resolve(),
    wakeCount: 0,
    shutdownPromise: undefined,
  };
  runtimeRef = session;

  for (const engine of [events, tasks, resources]) {
    cleanups.push(
      engine.onWake(() => {
        updateFooter(session);
        for (const listener of [...wakeListeners]) {
          listener();
        }
        notifySettleListeners(session);
      }),
    );
    if (engine.onStateChange) {
      cleanups.push(
        engine.onStateChange(() => {
          updateFooter(session);
          notifySettleListeners(session);
        }),
      );
    }
  }

  return session;
}

function shutdownSession(
  session: SessionRuntime | undefined,
  ctx?: ExtensionContext,
): Promise<void> {
  if (!session) {
    if (ctx?.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    return Promise.resolve();
  }
  if (session.shutdownPromise) {
    if (ctx?.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    return session.shutdownPromise;
  }

  session.shutdownPromise = (async (): Promise<void> => {
    // Flush coalesced event/resource batches while wake() is still live so cursors commit after delivery.
    session.events.flushPending?.();
    session.resources.flushPending?.();
    session.controller.abort();
    const uiCtx = ctx ?? session.latestCtx;
    if (uiCtx?.hasUI) {
      uiCtx.ui.setStatus(STATUS_KEY, undefined);
    }

    for (const off of session.clientCleanups.values()) {
      try {
        off();
      } catch {
        // Ignore listener cleanup errors.
      }
    }
    session.clientCleanups.clear();
    const cleanups = session.cleanups.splice(0, session.cleanups.length);
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Ignore listener cleanup errors.
      }
    }
    session.wakeListeners.clear();
    session.settleListeners.clear();

    await Promise.allSettled([
      session.events.shutdown(),
      session.tasks.shutdown(),
      session.resources.shutdown(),
      session.prompts.shutdown(),
      session.skills.shutdown(),
      session.toolsFallback.shutdown(),
    ]);
    await Promise.allSettled(
      [...session.clients.values()].map((client: ServerClient) => client.close()),
    );
    session.clients.clear();
    session.probePromises.clear();
    session.activationPromises.clear();
    cleanupPrivateTempDir();

    if (uiCtx?.hasUI) {
      uiCtx.ui.setStatus(STATUS_KEY, undefined);
    }
  })();

  return session.shutdownPromise;
}

// ---------------------------------------------------------------------------------------------
// Custom message rendering ('mcp-event' & 'mcp-task')
// ---------------------------------------------------------------------------------------------

const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|_.*?\x07|\].*?(?:\x07|\x1b\\))/g;

type RenderedCustomMessage = Parameters<MessageRenderer>[0];

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function extractMessageText(content: RenderedCustomMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block: TextContent) => block.text)
    .join("\n");
}

function singleLineFallback(content: RenderedCustomMessage["content"]): string {
  const first = extractMessageText(content)
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .find((line: string) => line.length > 0);
  return first ?? "delivery";
}

function summarizeEventDetails(message: RenderedCustomMessage): string {
  const details = message.details;
  if (Array.isArray(details) && details.length > 0) {
    let count = 0;
    const sources: string[] = [];
    for (const entry of details) {
      if (isPlainObject(entry)) {
        const occ = Array.isArray(entry.occurrences) ? entry.occurrences.length : 1;
        count += occ;
        if (typeof entry.server === "string" && typeof entry.name === "string") {
          sources.push(`${entry.server}/${entry.name}`);
        }
      }
    }
    if (sources.length > 0) {
      return `${sources.join(", ")} (${count} ${count === 1 ? "event" : "events"})`;
    }
  }
  if (isPlainObject(details)) {
    if (Array.isArray(details.deliveries) && details.deliveries.length > 0) {
      let count = 0;
      const names: string[] = [];
      for (const d of details.deliveries) {
        if (isPlainObject(d)) {
          count += Array.isArray(d.occurrences) ? d.occurrences.length : 1;
          if (typeof d.server === "string" && typeof d.name === "string") {
            names.push(`${d.server}/${d.name}`);
          }
        }
      }
      if (names.length > 0) {
        return `${names.join(", ")} (${count} ${count === 1 ? "event" : "events"})`;
      }
    }
    const server = typeof details.server === "string" ? details.server : undefined;
    const name = typeof details.name === "string" ? details.name : undefined;
    if (Array.isArray(details.occurrences)) {
      const count = details.occurrences.length;
      const target = server && name ? `${server}/${name}` : (name ?? server ?? "stream");
      const trunc = details.truncated === true ? ", truncated" : "";
      return `${target}: ${count} ${count === 1 ? "event" : "events"}${trunc}`;
    }
    if (server || name) {
      const target = server && name ? `${server}/${name}` : (server ?? name ?? "event");
      const note =
        typeof details.reason === "string"
          ? ` (${details.reason})`
          : typeof details.message === "string"
            ? `: ${details.message}`
            : "";
      return `${target}${note}`;
    }
  }
  return singleLineFallback(message.content).replace(/\s+/g, " ");
}

function summarizeTaskDetails(message: RenderedCustomMessage): string {
  const details = message.details;
  if (isPlainObject(details)) {
    const taskObj = isPlainObject(details.task) ? details.task : details;
    const server = typeof details.server === "string" ? details.server : undefined;
    const tool =
      typeof details.toolName === "string"
        ? details.toolName
        : typeof details.tool === "string"
          ? details.tool
          : undefined;
    const taskId =
      typeof details.taskId === "string"
        ? details.taskId
        : typeof taskObj.taskId === "string"
          ? taskObj.taskId
          : undefined;
    const status =
      typeof details.status === "string"
        ? details.status
        : typeof taskObj.status === "string"
          ? taskObj.status
          : undefined;

    if (server || tool || taskId || status) {
      const head =
        server && tool ? `${server}/${tool}` : (server ?? tool ?? "task");
      const idPart = taskId ? ` #${taskId}` : "";
      const statusPart = status ? ` -> ${status}` : "";
      return `${head}${idPart}${statusPart}`;
    }
  }
  return singleLineFallback(message.content).replace(/\s+/g, " ");
}

function summarizeResourceDetails(message: RenderedCustomMessage): string {
  const details = message.details;
  if (isPlainObject(details) && Array.isArray(details.resources)) {
    const parts: string[] = [];
    for (const item of details.resources) {
      if (!isPlainObject(item) || typeof item.server !== "string") continue;
      const uris = Array.isArray(item.updatedUris)
        ? item.updatedUris.filter((u): u is string => typeof u === "string")
        : [];
      if (uris.length > 0) parts.push(`${item.server}: ${uris.join(", ")}`);
      else if (item.listChanged === true) parts.push(`${item.server}: list changed`);
    }
    if (parts.length > 0) return parts.join(" · ");
  }
  return singleLineFallback(message.content).replace(/\s+/g, " ");
}

function clampPlainText(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (text.length <= maxCols) return text;
  if (maxCols === 1) return "…";
  return `${text.slice(0, maxCols - 1)}…`;
}

function splitPlainWidth(line: string, maxCols: number): string[] {
  const safeWidth = Math.max(1, maxCols);
  if (line.length <= safeWidth) return [line];
  const chunks: string[] = [];
  for (let offset = 0; offset < line.length; offset += safeWidth) {
    chunks.push(line.slice(offset, offset + safeWidth));
  }
  return chunks;
}

function createExpandableJsonRenderer(
  badgeLabel: string,
  summarize: (message: RenderedCustomMessage) => string,
): MessageRenderer {
  return (
    message: RenderedCustomMessage,
    options: MessageRenderOptions,
    theme: Theme,
  ): NonNullable<ReturnType<MessageRenderer>> => {
    const summaryPlain = summarize(message).replace(/[\r\n\t]+/g, " ").trim();
    const jsonSource =
      message.details !== undefined
        ? message.details
        : { customType: message.customType, content: extractMessageText(message.content) };
    const jsonFormatted = JSON.stringify(jsonSource, null, 2) ?? "null";

    return {
      invalidate(): void {},
      render(width: number): string[] {
        const totalWidth = Math.max(1, width);
        const padCount = Math.min(
          Math.max(0, options.outputPad ?? 0),
          Math.max(0, Math.floor((totalWidth - 1) / 2)),
        );
        const pad = " ".repeat(padCount);
        const innerWidth = Math.max(1, totalWidth - padCount * 2);
        const rawBadge = `[${badgeLabel}]`;

        if (!options.expanded) {
          const expandHint = options.keyHint("app.tools.expand", "to expand");
          const hintVisible = stripAnsi(expandHint);
          const hintSuffixPlain = hintVisible.length > 0 ? ` (${hintVisible})` : "";
          const badgeAndSpace = rawBadge.length + 1;

          if (innerWidth <= rawBadge.length) {
            const clipped = clampPlainText(rawBadge, innerWidth);
            return [
              theme.bg(
                "customMessageBg",
                pad + theme.fg("customMessageLabel", theme.bold(clipped)) + " ".repeat(Math.max(0, totalWidth - padCount - clipped.length)),
              ),
            ];
          }

          const includeHint =
            hintSuffixPlain.length > 0 &&
            innerWidth > badgeAndSpace + hintSuffixPlain.length + 4;
          const summaryBudget =
            innerWidth - badgeAndSpace - (includeHint ? hintSuffixPlain.length : 0);
          const clampedSummary = clampPlainText(summaryPlain, summaryBudget);
          const hintRendered = includeHint
            ? ` ${theme.fg("muted", "(")}${expandHint}${theme.fg("muted", ")")}`
            : "";
          const visibleContentLen =
            rawBadge.length +
            1 +
            clampedSummary.length +
            (includeHint ? hintSuffixPlain.length : 0);
          const trailingSpaces = " ".repeat(Math.max(0, totalWidth - padCount - visibleContentLen));
          const styledLine =
            pad +
            theme.fg("customMessageLabel", theme.bold(rawBadge)) +
            " " +
            theme.fg("customMessageText", clampedSummary) +
            hintRendered +
            trailingSpaces;
          return [theme.bg("customMessageBg", styledLine)];
        }

        const lines: string[] = [];
        const headerSummary = clampPlainText(
          summaryPlain,
          Math.max(0, innerWidth - rawBadge.length - 1),
        );
        const headerVisibleLen =
          rawBadge.length + (headerSummary.length > 0 ? 1 + headerSummary.length : 0);
        const headerTrailing = " ".repeat(Math.max(0, totalWidth - padCount - headerVisibleLen));
        const headerLine =
          pad +
          theme.fg("customMessageLabel", theme.bold(rawBadge)) +
          (headerSummary.length > 0 ? ` ${theme.fg("customMessageText", headerSummary)}` : "") +
          headerTrailing;
        lines.push(theme.bg("customMessageBg", headerLine));

        for (const rawJsonLine of jsonFormatted.replace(/\t/g, "  ").split("\n")) {
          for (const chunk of splitPlainWidth(rawJsonLine, innerWidth)) {
            const rightPad = " ".repeat(Math.max(0, totalWidth - padCount - chunk.length));
            lines.push(
              theme.bg(
                "customMessageBg",
                `${pad}${theme.fg("customMessageText", chunk)}${rightPad}`,
              ),
            );
          }
        }
        return lines;
      },
    };
  };
}

// ---------------------------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------------------------

export default function extension(pi: ExtensionAPI): void {
  let currentSession: SessionRuntime | undefined;
  const registeredPromptCommandNames = new Set<string>();

  function requireActiveSession(): SessionRuntime {
    if (!currentSession || currentSession.controller.signal.aborted) {
      throw new Error("MCP extension session is not active.");
    }
    return currentSession;
  }

  async function executeSlashPrompt(
    serverName: string,
    promptName: string,
    rawArgs: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const session = requireActiveSession();
    session.latestCtx = ctx;
    await ensureModernCapability(session, serverName, "prompts", undefined);
    const descriptors = await session.prompts.list(serverName);
    const descriptor = descriptors.find((d) => d.name === promptName);
    const parsed = parseSlashPromptInput(rawArgs, descriptor?.arguments);
    const resolvedArgs = { ...parsed.resolved };

    // Prompt interactively for any missing required arguments when UI is available.
    if (ctx.hasUI && descriptor?.arguments) {
      for (const argDef of descriptor.arguments) {
        if (argDef.required && !(argDef.name in resolvedArgs)) {
          const val = await ctx.ui.input(
            `[${serverName}/${promptName}] ${argDef.title ?? argDef.name}${argDef.description ? ` — ${argDef.description}` : ""}`,
            "Required argument",
          );
          if (val === undefined) return;
          resolvedArgs[argDef.name] = val;
        }
      }
    }

    const promptRes = await session.prompts.get(serverName, promptName, resolvedArgs);
    if (promptRes.images.length > 0) {
      const blocks: Array<TextContent | ImageContent> = [];
      if (promptRes.renderedText) blocks.push({ type: "text", text: promptRes.renderedText });
      blocks.push(...promptRes.images);
      pi.sendUserMessage(blocks);
    } else {
      pi.sendUserMessage(promptRes.renderedText || `Run prompt ${serverName}/${promptName}`);
    }
  }

  function ensurePerPromptCommand(serverName: string, prompt: PromptDescriptor): void {
    const cmdName = `mcp-prompt:${serverName}:${prompt.name}`;
    if (registeredPromptCommandNames.has(cmdName)) return;
    registeredPromptCommandNames.add(cmdName);
    pi.registerCommand(cmdName, {
      description: prompt.description ?? prompt.title ?? `MCP prompt ${prompt.name} (${serverName})`,
      getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
        const session = currentSession;
        if (!session || session.controller.signal.aborted) return null;
        const latestDesc = session.prompts
          .cachedPrompts()
          .find((p) => p.server === serverName && p.prompt.name === prompt.name)?.prompt;
        if (!latestDesc) return null;
        const parsed = parseSlashPromptInput(prefix, latestDesc.arguments);
        if (!parsed.completing) return null;
        try {
          const comp = await session.prompts.complete(
            serverName,
            { type: "ref/prompt", name: prompt.name },
            { name: parsed.completing.name, value: parsed.completing.value },
            parsed.resolved,
          );
          if (comp.values.length === 0) return null;
          return comp.values.map((v) => {
            const quoted = /\s/.test(v) ? JSON.stringify(v) : v;
            const fullVal = `${parsed.completing!.replacePrefix}${quoted}`;
            return { value: fullVal, label: v, description: `${parsed.completing!.name}` };
          });
        } catch {
          return null;
        }
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        try {
          await executeSlashPrompt(serverName, prompt.name, args, ctx);
        } catch (err) {
          if (ctx.hasUI) ctx.ui.notify(errorMessage(err), "error");
          else throw err;
        }
      },
    });
  }

  pi.registerCommand("mcp-prompt", {
    description: "Invoke an MCP 2026-07-28 server prompt (/mcp-prompt <server>/<prompt> [key=value ...])",
    getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
      const session = currentSession;
      if (!session || session.controller.signal.aborted) return null;
      const all = session.prompts.cachedPrompts();
      if (all.length === 0) return null;

      const firstSpace = prefix.indexOf(" ");
      if (firstSpace === -1) {
        const matches = all
          .map(({ server, prompt }) => ({
            target: `${server}/${prompt.name}`,
            desc: prompt.description ?? prompt.title,
          }))
          .filter((item) => item.target.startsWith(prefix));
        return matches.length > 0
          ? matches.map((m) => ({
              value: `${m.target} `,
              label: m.target,
              ...(m.desc ? { description: m.desc } : {}),
            }))
          : null;
      }

      const head = prefix.slice(0, firstSpace);
      const slash = head.indexOf("/");
      if (slash <= 0) return null;
      const serverName = head.slice(0, slash);
      const promptName = head.slice(slash + 1);
      const found = all.find((p) => p.server === serverName && p.prompt.name === promptName);
      if (!found) return null;

      const tail = prefix.slice(firstSpace + 1);
      const parsed = parseSlashPromptInput(tail, found.prompt.arguments);
      if (!parsed.completing) return null;
      try {
        const comp = await session.prompts.complete(
          serverName,
          { type: "ref/prompt", name: promptName },
          { name: parsed.completing.name, value: parsed.completing.value },
          parsed.resolved,
        );
        if (comp.values.length === 0) return null;
        return comp.values.map((v) => {
          const quoted = /\s/.test(v) ? JSON.stringify(v) : v;
          return {
            value: `${head} ${parsed.completing!.replacePrefix}${quoted}`,
            label: v,
            description: parsed.completing!.name,
          };
        });
      } catch {
        return null;
      }
    },
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const session = requireActiveSession();
      session.latestCtx = ctx;
      await raceWithSignals(session.configLoadChain, [session.controller.signal]);
      if (session.probePromises.size > 0) {
        await Promise.allSettled([...session.probePromises.values()]);
      }

      const trimmed = args.trim();
      if (!trimmed) {
        const available = session.prompts.cachedPrompts();
        if (available.length === 0) {
          if (ctx.hasUI) ctx.ui.notify("No MCP 2026-07-28 prompts discovered on connected servers.", "info");
          return;
        }
        if (!ctx.hasUI) return;
        const labels = available.map(
          ({ server, prompt }) =>
            `${server}/${prompt.name}${prompt.description ? ` — ${prompt.description}` : ""}`,
        );
        const picked = await ctx.ui.select("Select an MCP prompt", labels);
        if (!picked) return;
        const idx = labels.indexOf(picked);
        if (idx < 0) return;
        const chosen = available[idx];
        await executeSlashPrompt(chosen.server, chosen.prompt.name, "", ctx);
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const head = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
      const slashIdx = head.indexOf("/");
      if (slashIdx <= 0 || slashIdx === head.length - 1) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /mcp-prompt <server>/<prompt> [key=value ...]", "warning");
        return;
      }
      await executeSlashPrompt(head.slice(0, slashIdx), head.slice(slashIdx + 1), rest, ctx);
    },
  });

  pi.registerMessageRenderer(
    MESSAGE_EVENT,
    createExpandableJsonRenderer(MESSAGE_EVENT, summarizeEventDetails),
  );
  pi.registerMessageRenderer(
    MESSAGE_TASK,
    createExpandableJsonRenderer(MESSAGE_TASK, summarizeTaskDetails),
  );
  pi.registerMessageRenderer(
    MESSAGE_RESOURCE,
    createExpandableJsonRenderer(MESSAGE_RESOURCE, summarizeResourceDetails),
  );

  pi.registerTool({
    name: "mcp_events",
    label: "MCP Events",
    description:
      "Inspect MCP 2026-07-28 servers, list event types, manage event subscriptions, or poll events once.",
    exposure: "direct",
    parameters: McpEventsParams,
    async execute(
      _toolCallId: string,
      params: McpEventsInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<unknown>> {
      if (currentSession && ctx) {
        currentSession.latestCtx = ctx;
      }

      switch (params.action) {
        case "servers": {
          if (!currentSession || currentSession.controller.signal.aborted) {
            return jsonResult<ServerState[]>([]);
          }
          const session = currentSession;
          await raceWithSignals(session.configLoadChain, [signal, session.controller.signal]);
          if (session.probePromises.size > 0) {
            await raceWithSignals(
              Promise.allSettled([...session.probePromises.values()]),
              [signal, session.controller.signal],
            );
          }
          const states: ServerState[] = [];
          for (const [name, cfg] of session.configuredServers) {
            const client = session.clients.get(name);
            states.push(client ? { ...client.state } : disabledServerState(cfg));
          }
          updateFooter(session, ctx);
          return jsonResult(states);
        }

        case "subscriptions": {
          if (!currentSession || currentSession.controller.signal.aborted) {
            return jsonResult([]);
          }
          const session = currentSession;
          await raceWithSignals(session.configLoadChain, [signal, session.controller.signal]);
          if (session.activationPromises.size > 0) {
            await raceWithSignals(
              Promise.allSettled([...session.activationPromises.values()]),
              [signal, session.controller.signal],
            );
          }
          const all = session.events.subscriptions();
          const filtered = params.server
            ? all.filter((sub) => sub.server === params.server)
            : all;
          updateFooter(session, ctx);
          return jsonResult(filtered);
        }

        case "list": {
          if (!params.server) {
            throw new Error('mcp_events action "list" requires parameter "server".');
          }
          const session = requireActiveSession();
          await ensureModernCapability(session, params.server, "events", signal);
          const collector = createLogCollector(params.server, params.logLevel);
          try {
            const list = await session.events.list(params.server, collector.opts);
            updateFooter(session, ctx);
            return jsonResult(list, collector.logs);
          } catch (err) {
            throw normalizeServerCallError(params.server, err);
          }
        }

        case "subscribe": {
          if (!params.server) {
            throw new Error('mcp_events action "subscribe" requires parameter "server".');
          }
          if (!params.name) {
            throw new Error('mcp_events action "subscribe" requires parameter "name".');
          }
          const session = requireActiveSession();
          await ensureModernCapability(session, params.server, "events", signal);
          const mode = ctx?.mode ?? session.latestCtx?.mode;
          const defaultHoldSettle = mode === "print" || mode === "json";
          const req: SubscribeRequest = {
            server: params.server,
            name: params.name,
            ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
            delivery: params.delivery ?? "auto",
            ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
            ...(params.maxAgeMs !== undefined ? { maxAgeMs: params.maxAgeMs } : {}),
            holdSettle: params.holdSettle ?? defaultHoldSettle,
          };
          try {
            const subscription = await session.events.subscribe(req);
            updateFooter(session, ctx);
            return jsonResult(subscription);
          } catch (err) {
            throw normalizeServerCallError(params.server, err);
          }
        }

        case "unsubscribe": {
          if (!params.server) {
            throw new Error('mcp_events action "unsubscribe" requires parameter "server".');
          }
          if (!params.name) {
            throw new Error('mcp_events action "unsubscribe" requires parameter "name".');
          }
          const session = requireActiveSession();
          await raceWithSignals(session.configLoadChain, [signal, session.controller.signal]);
          const probe = session.probePromises.get(params.server);
          if (probe) {
            await raceWithSignals(probe, [signal, session.controller.signal]);
          }
          const hasPersisted = session.events
            .subscriptions()
            .some((sub) => sub.server === params.server);
          if (!session.configuredServers.has(params.server) && !hasPersisted) {
            throw new Error(
              `Unknown MCP server "${params.server}". Configured servers: ${configuredNamesList(session)}.`,
            );
          }
          try {
            const removed = await session.events.unsubscribe(
              params.server,
              params.name,
              params.arguments,
            );
            updateFooter(session, ctx);
            return jsonResult({
              server: params.server,
              name: params.name,
              removed,
            });
          } catch (err) {
            throw normalizeServerCallError(params.server, err);
          }
        }

        case "poll": {
          if (!params.server) {
            throw new Error('mcp_events action "poll" requires parameter "server".');
          }
          if (!params.name) {
            throw new Error('mcp_events action "poll" requires parameter "name".');
          }
          const session = requireActiveSession();
          await ensureModernCapability(session, params.server, "events", signal);
          const pollParams: PollEventsParams = {
            name: params.name,
            ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
            cursor: params.cursor ?? null,
            ...(params.maxAgeMs !== undefined ? { maxAgeMs: params.maxAgeMs } : {}),
            ...(params.maxEvents !== undefined ? { maxEvents: params.maxEvents } : {}),
          };
          const collector = createLogCollector(params.server, params.logLevel);
          try {
            const result = await session.events.poll(params.server, pollParams, collector.opts);
            updateFooter(session, ctx);
            return jsonResult(result, collector.logs);
          } catch (err) {
            throw normalizeServerCallError(params.server, err);
          }
        }
      }
    },
  });

  pi.registerTool({
    name: "mcp_tasks",
    label: "MCP Tasks",
    description:
      "Call MCP tools with 2026-07-28 task support, inspect or answer inputRequests, cancel tasks, or list active session tasks.",
    exposure: "direct",
    parameters: McpTasksParams,
    async execute(
      _toolCallId: string,
      params: McpTasksInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<unknown>> {
      if (currentSession && ctx) {
        currentSession.latestCtx = ctx;
      }

      switch (params.action) {
        case "active": {
          if (!currentSession || currentSession.controller.signal.aborted) {
            return jsonResult([]);
          }
          const session = currentSession;
          const active = session.tasks.active();
          const filtered = params.server
            ? active.filter((task) => task.server === params.server)
            : active;
          updateFooter(session, ctx);
          return jsonResult(filtered);
        }

        case "call": {
          if (!params.server) {
            throw new Error('mcp_tasks action "call" requires parameter "server".');
          }
          if (!params.tool) {
            throw new Error('mcp_tasks action "call" requires parameter "tool".');
          }
          const session = requireActiveSession();
          await ensureModernCapability(session, params.server, "tasks", signal);
          const collector = createLogCollector(params.server, params.logLevel);
          try {
            const outcome = await session.tasks.call(
              params.server,
              params.tool,
              params.arguments,
              signal,
              collector.opts,
            );
            updateFooter(session, ctx);
            return jsonResult(outcome, collector.logs);
          } catch (err) {
            throw normalizeServerCallError(params.server, err);
          }
        }

        case "get": {
          if (!params.server) {
            throw new Error('mcp_tasks action "get" requires parameter "server".');
          }
          if (!params.taskId) {
            throw new Error('mcp_tasks action "get" requires parameter "taskId".');
          }
          const session = requireActiveSession();
          await ensureModernCapability(session, params.server, "tasks", signal);
          const collector = createLogCollector(params.server, params.logLevel);
          try {
            const task = await session.tasks.get(params.server, params.taskId, collector.opts);
            updateFooter(session, ctx);
            return jsonResult(task, collector.logs);
          } catch (err) {
            throw normalizeServerCallError(params.server, err);
          }
        }

        case "update": {
          if (!params.server) {
            throw new Error('mcp_tasks action "update" requires parameter "server".');
          }
          if (!params.taskId) {
            throw new Error('mcp_tasks action "update" requires parameter "taskId".');
          }
          if (!params.inputResponses) {
            throw new Error(
              'mcp_tasks action "update" requires parameter "inputResponses".',
            );
          }
          const session = requireActiveSession();
          await ensureModernCapability(session, params.server, "tasks", signal);
          const collector = createLogCollector(params.server, params.logLevel);
          try {
            await session.tasks.update(
              params.server,
              params.taskId,
              params.inputResponses,
              collector.opts,
            );
            updateFooter(session, ctx);
            return jsonResult(
              {
                server: params.server,
                taskId: params.taskId,
                updated: true,
              },
              collector.logs,
            );
          } catch (err) {
            throw normalizeServerCallError(params.server, err);
          }
        }

        case "cancel": {
          if (!params.server) {
            throw new Error('mcp_tasks action "cancel" requires parameter "server".');
          }
          if (!params.taskId) {
            throw new Error('mcp_tasks action "cancel" requires parameter "taskId".');
          }
          const session = requireActiveSession();
          await ensureModernCapability(session, params.server, "tasks", signal);
          const collector = createLogCollector(params.server, params.logLevel);
          try {
            await session.tasks.cancel(params.server, params.taskId, collector.opts);
            updateFooter(session, ctx);
            return jsonResult(
              {
                server: params.server,
                taskId: params.taskId,
                cancelled: true,
              },
              collector.logs,
            );
          } catch (err) {
            throw normalizeServerCallError(params.server, err);
          }
        }
      }
    },
  });

  pi.registerTool({
    name: "mcp_resources",
    label: "MCP Resources",
    description:
      "List, read, browse directories, or subscribe to live updates on MCP 2026-07-28 server resources.",
    exposure: "direct",
    parameters: McpResourcesParams,
    async execute(
      _toolCallId: string,
      params: McpResourcesInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<unknown>> {
      if (currentSession && ctx) currentSession.latestCtx = ctx;

      if (params.action === "subscriptions") {
        if (!currentSession || currentSession.controller.signal.aborted) {
          return jsonResult([]);
        }
        const session = currentSession;
        await raceWithSignals(session.configLoadChain, [signal, session.controller.signal]);
        if (session.probePromises.size > 0) {
          await raceWithSignals(
            Promise.allSettled([...session.probePromises.values()]),
            [signal, session.controller.signal],
          );
        }
        updateFooter(session, ctx);
        return jsonResult(session.resources.subscriptions(params.server));
      }

      if (!params.server) {
        throw new Error(`mcp_resources action "${params.action}" requires parameter "server".`);
      }
      const session = requireActiveSession();

      if (params.action === "unsubscribe") {
        if (!params.uri) {
          throw new Error('mcp_resources action "unsubscribe" requires parameter "uri".');
        }
        const removed = session.resources.unsubscribe(params.server, params.uri);
        updateFooter(session, ctx);
        return jsonResult({ server: params.server, uri: params.uri, removed });
      }

      await ensureModernCapability(session, params.server, "resources", signal);
      const collector = createLogCollector(params.server, params.logLevel);

      try {
        switch (params.action) {
          case "list": {
            const out = await session.resources.list(params.server, params.cursor, collector.opts);
            return jsonResult({ server: params.server, ...out }, collector.logs);
          }
          case "templates": {
            const out = await session.resources.templates(
              params.server,
              params.cursor,
              collector.opts,
            );
            return jsonResult({ server: params.server, ...out }, collector.logs);
          }
          case "read": {
            if (!params.uri) {
              throw new Error('mcp_resources action "read" requires parameter "uri".');
            }
            const out = await session.resources.read(params.server, params.uri, collector.opts);
            const content: Array<TextContent | ImageContent> = [...out.blocks];
            if (collector.logs.length > 0) {
              content.push({ type: "text", text: collector.logs.join("\n") });
            }
            return {
              content,
              structuredContent: { server: params.server, uri: params.uri, contents: out.contents },
              details: { server: params.server, uri: params.uri, contents: out.contents },
            } as AgentToolResult<unknown>;
          }
          case "directory": {
            if (!params.uri) {
              throw new Error('mcp_resources action "directory" requires parameter "uri".');
            }
            const out = await session.resources.directory(
              params.server,
              params.uri,
              params.cursor,
              collector.opts,
            );
            return jsonResult({ server: params.server, uri: params.uri, ...out }, collector.logs);
          }
          case "subscribe": {
            if (!params.uri) {
              throw new Error('mcp_resources action "subscribe" requires parameter "uri".');
            }
            const mode = ctx?.mode ?? session.latestCtx?.mode;
            const defaultHold = mode === "print" || mode === "json";
            const rec = session.resources.subscribe(
              params.server,
              params.uri,
              params.holdSettle ?? defaultHold,
            );
            updateFooter(session, ctx);
            return jsonResult(rec);
          }
        }
      } catch (err) {
        throw normalizeServerCallError(params.server, err);
      }
    },
  });

  pi.registerTool({
    name: "mcp_prompts",
    label: "MCP Prompts",
    description:
      "List MCP 2026-07-28 prompts, retrieve rendered prompt messages, or autocomplete prompt/resource arguments.",
    exposure: "direct",
    parameters: McpPromptsParams,
    async execute(
      _toolCallId: string,
      params: McpPromptsInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<unknown>> {
      if (currentSession && ctx) currentSession.latestCtx = ctx;
      const session = requireActiveSession();
      const collector = createLogCollector(params.server, params.logLevel);

      try {
        switch (params.action) {
          case "list": {
            await ensureModernCapability(session, params.server, "prompts", signal);
            const prompts = await session.prompts.list(params.server, collector.opts);
            return jsonResult({ server: params.server, prompts }, collector.logs);
          }
          case "get": {
            if (!params.name) {
              throw new Error('mcp_prompts action "get" requires parameter "name".');
            }
            await ensureModernCapability(session, params.server, "prompts", signal);
            const res = await session.prompts.get(
              params.server,
              params.name,
              params.arguments,
              collector.opts,
            );
            const content: Array<TextContent | ImageContent> = [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    server: params.server,
                    name: params.name,
                    ...(res.description ? { description: res.description } : {}),
                    messages: res.messages,
                    renderedText: res.renderedText,
                  },
                  null,
                  2,
                ),
              },
              ...res.images,
            ];
            if (collector.logs.length > 0) {
              content.push({ type: "text", text: collector.logs.join("\n") });
            }
            return {
              content,
              details: { server: params.server, name: params.name, messages: res.messages },
            };
          }
          case "complete": {
            if (!params.argumentName) {
              throw new Error('mcp_prompts action "complete" requires parameter "argumentName".');
            }
            await ensureModernCapability(session, params.server, "completions", signal);
            const isResource = params.refType === "resource" || Boolean(params.uri && !params.name);
            if (isResource) {
              if (!params.uri) {
                throw new Error('mcp_prompts resource completion requires parameter "uri".');
              }
              const out = await session.prompts.complete(
                params.server,
                { type: "ref/resource", uri: params.uri },
                { name: params.argumentName, value: params.argumentValue ?? "" },
                params.arguments,
                collector.opts,
              );
              return jsonResult(out, collector.logs);
            }
            if (!params.name) {
              throw new Error('mcp_prompts prompt completion requires parameter "name".');
            }
            const out = await session.prompts.complete(
              params.server,
              { type: "ref/prompt", name: params.name },
              { name: params.argumentName, value: params.argumentValue ?? "" },
              params.arguments,
              collector.opts,
            );
            return jsonResult(out, collector.logs);
          }
        }
      } catch (err) {
        throw normalizeServerCallError(params.server, err);
      }
    },
  });

  pi.registerTool({
    name: "mcp_skills",
    label: "MCP Skills",
    description:
      "Discover, verify, approve, and load Agent Skills over MCP (io.modelcontextprotocol/skills) and their supporting files.",
    exposure: "direct",
    parameters: McpSkillsParams,
    async execute(
      _toolCallId: string,
      params: McpSkillsInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<unknown>> {
      if (currentSession && ctx) currentSession.latestCtx = ctx;
      const session = requireActiveSession();
      await ensureModernCapability(session, params.server, "skills", signal);
      const collector = createLogCollector(params.server, params.logLevel);

      try {
        switch (params.action) {
          case "list": {
            const skills = await session.skills.list(params.server, collector.opts);
            return jsonResult({ server: params.server, skills }, collector.logs);
          }
          case "get": {
            if (!params.uri) {
              throw new Error('mcp_skills action "get" requires parameter "uri".');
            }
            const skill = await session.skills.get(params.server, params.uri, collector.opts);
            return jsonResult({ server: params.server, skill }, collector.logs);
          }
          case "load": {
            if (!params.uri) {
              throw new Error('mcp_skills action "load" requires parameter "uri".');
            }
            const loaded = await session.skills.load(params.server, params.uri, {
              ...collector.opts,
              approve: ctx?.hasUI
                ? async ({ server, entry, fileCount, totalBytes }) => {
                    const dynamicNote =
                      entry.resources === "dynamic"
                        ? "\nWARNING: Dynamic skill (content has no pinned SHA-256 manifest; approval applies to this load only)."
                        : `\nManifest: ${fileCount} file(s), ${totalBytes} bytes (SHA-256 verified).`;
                    const allowedToolsNote =
                      entry.frontmatter["allowed-tools"] !== undefined
                        ? `\nRequested allowed-tools: ${JSON.stringify(entry.frontmatter["allowed-tools"])}`
                        : "";
                    return ctx.ui.confirm(
                      `Approve MCP skill "${entry.frontmatter.name}" from "${server}"?`,
                      `URI: ${entry.uri}\nDescription: ${entry.frontmatter.description}${dynamicNote}${allowedToolsNote}`,
                    );
                  }
                : undefined,
            });
            const escAttr = (s: string) =>
              s
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
            const escBody = loaded.content.replace(/<\/(mcp_[a-zA-Z0-9_]*)/gi, "<\\/$1");
            const framed =
              `<mcp_skill server="${escAttr(loaded.server)}" uri="${escAttr(loaded.uri)}" name="${escAttr(loaded.name)}">\n` +
              `${escBody}\n` +
              `</mcp_skill>`;
            const content: TextContent[] = [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    server: loaded.server,
                    uri: loaded.uri,
                    name: loaded.name,
                    description: loaded.description,
                    supportingUris: loaded.supportingUris,
                    ...(loaded.cacheDir ? { cacheDir: loaded.cacheDir } : {}),
                  },
                  null,
                  2,
                ),
              },
              { type: "text", text: framed },
            ];
            if (collector.logs.length > 0) {
              content.push({ type: "text", text: collector.logs.join("\n") });
            }
            return { content, details: loaded };
          }
          case "read_file": {
            if (!params.uri) {
              throw new Error('mcp_skills action "read_file" requires parameter "uri" (skill SKILL.md URI).');
            }
            if (!params.path) {
              throw new Error('mcp_skills action "read_file" requires parameter "path".');
            }
            const file = await session.skills.readFile(
              params.server,
              params.uri,
              params.path,
              collector.opts,
            );
            return jsonResult(file, collector.logs);
          }
          case "directory": {
            if (!params.uri) {
              throw new Error('mcp_skills action "directory" requires parameter "uri".');
            }
            const dir = await session.skills.directory(
              params.server,
              params.uri,
              params.cursor,
              collector.opts,
            );
            return jsonResult({ server: params.server, uri: params.uri, ...dir }, collector.logs);
          }
        }
      } catch (err) {
        throw normalizeServerCallError(params.server, err);
      }
    },
  });

  pi.on("resources_discover", async () => {
    const skillPaths = currentSession?.skills.verifiedSkillPaths() ?? [];
    return skillPaths.length > 0 ? { skillPaths } : {};
  });

  pi.on("session_start", async (_event, ctx) => {
    if (currentSession) {
      await shutdownSession(currentSession, ctx);
    }

    const session = createSessionRuntime(pi, ctx);
    currentSession = session;

    session.cleanups.push(
      session.prompts.onPromptsChanged((serverName, prompts) => {
        for (const prompt of prompts) {
          ensurePerPromptCommand(serverName, prompt);
        }
      }),
    );

    const branchEntries = ctx.sessionManager.getBranch();
    const allEntries = ctx.sessionManager.getEntries();
    session.events.restore(branchEntries, allEntries);
    session.tasks.restore(branchEntries);
    session.resources.restore(branchEntries);
    session.skills.restore(allEntries);
    updateFooter(session, ctx);

    await queueConfigReload(session, {
      cwd: ctx.cwd,
      isProjectTrusted: ctx.isProjectTrusted(),
      sessionServers: toSessionServers(pi.getMcpServers()),
    });
  });

  pi.on("mcp_servers_change", async (event, ctx) => {
    const session = currentSession;
    if (!session || session.controller.signal.aborted) return;
    session.latestCtx = ctx;
    session.cwd = ctx.cwd;

    await queueConfigReload(session, {
      cwd: ctx.cwd,
      isProjectTrusted: ctx.isProjectTrusted(),
      sessionServers: toSessionServers(event.servers ?? pi.getMcpServers()),
    });
  });

  pi.on("session_tree", (_event, ctx) => {
    const session = currentSession;
    if (!session || session.controller.signal.aborted) return;
    session.latestCtx = ctx;
    const branch = ctx.sessionManager.getBranch();
    session.events.restore(branch, ctx.sessionManager.getEntries());
    session.tasks.restore(branch);
    session.resources.restore(branch);
    updateFooter(session, ctx);
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx): Promise<ToolResultEventResult | undefined> => {
    const session = currentSession;
    if (!session || session.controller.signal.aborted) return undefined;
    session.latestCtx = ctx;

    if (!event.isError || !event.toolName.startsWith("mcp__")) {
      return undefined;
    }

    const errorText = event.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block: TextContent) => block.text)
      .join("\n");
    if (!errorText.includes("-32021") || !errorText.includes(EXT_TASKS)) {
      return undefined;
    }

    await raceWithSignals(session.configLoadChain, [ctx.signal, session.controller.signal]);

    let serverName: string | undefined;
    let toolName: string | undefined;

    if (
      "details" in event &&
      isPlainObject(event.details) &&
      typeof event.details.server === "string" &&
      typeof event.details.tool === "string"
    ) {
      serverName = event.details.server;
      toolName = event.details.tool;
    } else {
      const candidates = [...session.configuredServers.values()]
        .filter(
          (cfg: ConfiguredServerEntry) =>
            event.toolName.startsWith(`${cfg.namespace}__`) &&
            event.toolName.length > cfg.namespace.length + 2,
        )
        .sort(
          (a: ConfiguredServerEntry, b: ConfiguredServerEntry) =>
            b.namespace.length - a.namespace.length,
        );
      const matched = candidates[0];
      if (matched) {
        serverName = matched.name;
        toolName = event.toolName.slice(matched.namespace.length + 2);
      }
    }

    if (!serverName || !toolName) return undefined;

    const probe = session.probePromises.get(serverName);
    if (probe) {
      await raceWithSignals(probe, [ctx.signal, session.controller.signal]);
    }

    const client = session.clients.get(serverName);
    if (!client || client.state.era !== "modern" || !client.state.tasks) {
      return undefined;
    }

    const callSpec = JSON.stringify({
      action: "call",
      server: serverName,
      tool: toolName,
      arguments: event.input,
    });
    const hint = `Hint: Tool "${toolName}" on MCP server "${serverName}" requires ${EXT_TASKS}; use mcp_tasks ${callSpec}.`;

    const nextContent = [...event.content];
    const lastIdx = nextContent.length - 1;
    const lastBlock = lastIdx >= 0 ? nextContent[lastIdx] : undefined;
    if (lastBlock && lastBlock.type === "text") {
      nextContent[lastIdx] = { ...lastBlock, text: `${lastBlock.text}\n${hint}` };
    } else {
      nextContent.push({ type: "text", text: hint });
    }

    return {
      content: nextContent,
      ...(event.structuredContent !== undefined
        ? { structuredContent: event.structuredContent }
        : {}),
    };
  });

  pi.on(
    "agent_before_settle",
    async (
      event: AgentBeforeSettleEvent,
      ctx: ExtensionContext,
    ): Promise<AgentBeforeSettleEventResult | undefined> => {
      if (ctx.mode !== "print" && ctx.mode !== "json") {
        return undefined;
      }
      if (
        event.outcome === "aborted" ||
        event.outcome === "error" ||
        ctx.signal?.aborted
      ) {
        return undefined;
      }

      const session = currentSession;
      if (!session || session.controller.signal.aborted) {
        return undefined;
      }
      session.latestCtx = ctx;

      await raceWithSignals(session.configLoadChain, [ctx.signal, session.controller.signal]);
      if (session.activationPromises.size > 0) {
        await raceWithSignals(
          Promise.allSettled([...session.activationPromises.values()]),
          [ctx.signal, session.controller.signal],
        );
      }
      if (ctx.signal?.aborted || session.controller.signal.aborted) {
        return undefined;
      }

      const isHolding = (): boolean =>
        session.tasks.hasPending() ||
        session.events.holdsSettle() ||
        session.resources.holdsSettle();

      if (!isHolding() || ctx.hasPendingMessages()) {
        return undefined;
      }

      const startWakeCount = session.wakeCount;

      const outcome = await new Promise<"woke" | "drained" | "aborted">((resolve) => {
        let settled = false;
        let offWake: (() => void) | undefined;
        let offSettle: (() => void) | undefined;
        const abortCleanups: Array<() => void> = [];

        const finish = (reason: "woke" | "drained" | "aborted") => {
          if (settled) return;
          settled = true;
          offWake?.();
          offSettle?.();
          for (const cleanup of abortCleanups) cleanup();
          resolve(reason);
        };

        const evaluate = () => {
          if (session.controller.signal.aborted || ctx.signal?.aborted) {
            finish("aborted");
            return;
          }
          if (session.wakeCount !== startWakeCount || ctx.hasPendingMessages()) {
            finish("woke");
            return;
          }
          if (!isHolding()) {
            finish("drained");
          }
        };

        const onWake = () => finish("woke");
        session.wakeListeners.add(onWake);
        offWake = () => {
          session.wakeListeners.delete(onWake);
        };

        session.settleListeners.add(evaluate);
        offSettle = () => {
          session.settleListeners.delete(evaluate);
        };

        for (const sig of [session.controller.signal, ctx.signal]) {
          if (!sig) continue;
          if (sig.aborted) {
            finish("aborted");
            return;
          }
          const onAbort = () => finish("aborted");
          sig.addEventListener("abort", onAbort, { once: true });
          abortCleanups.push(() => sig.removeEventListener("abort", onAbort));
        }

        evaluate();
      });

      if (outcome === "woke") {
        return { continue: true };
      }
      return undefined;
    },
  );

  pi.on("session_shutdown", async (_event, ctx) => {
    const session = currentSession;
    currentSession = undefined;
    await shutdownSession(session, ctx);
  });
}
