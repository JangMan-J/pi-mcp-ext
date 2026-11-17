/**
 * Pure `2026-07-28` Tools Fallback (`specification/2026-07-28/server/tools.md`).
 *
 * `builtin:mcp` hardcodes `2025-11-25` `initialize`. When a server speaks pure `2026-07-28`
 * (answering `server/discover` with `capabilities.tools`, while `builtin:mcp` failed to register
 * `mcp__<server>__*`), this module lists and registers `mcp__<server>__<tool>` with full
 * `exposure` / `toolExposure` parity and refreshes dynamically via `toolsListChanged` on
 * `subscriptions/listen`. On dual-stack servers where `builtin:mcp` already registered tools,
 * this module stands down completely.
 */

import { createHash } from "node:crypto";
import type { TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { convertMcpContentBlocks, paginateMcp, type ConvertedContent } from "./framing.ts";
import { validateXMcpHeaders } from "./transport-http.ts";
import type {
  CreateTaskResult,
  EngineHost,
  JSONRPCNotification,
  JsonObject,
  McpExposure,
  ResolvedServer,
  ServerClient,
  TasksEngineApi,
} from "./types.ts";

interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ToolsFallbackApi {
  /** Check if `builtin:mcp` owns `server`'s tools; if not, register `2026-07-28` fallback tools. Returns true if fallback took ownership. */
  activateIfUnowned(server: ResolvedServer): Promise<boolean>;
  /** Hide any fallback tools registered for `server` (on disable/removal). */
  deactivateServer(serverName: string): void;
  shutdown(): Promise<void>;
}

function isRecord(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeSegment(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return s || "_";
}

function createFallbackToolName(
  serverName: string,
  toolName: string,
  collides: (candidate: string) => boolean,
): string {
  const base = `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
  if (base.length <= 64 && !collides(base)) return base;
  const suffix = createHash("sha256").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 8);
  const maxPrefix = 64 - 1 - suffix.length;
  return `${base.slice(0, maxPrefix)}_${suffix}`;
}

function patternToRegExp(pattern: string): RegExp {
  const src = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${src}$`);
}

export function resolveEffectiveExposure(server: ResolvedServer, toolName: string): McpExposure {
  const overrides = server.toolExposure ?? {};
  if (overrides[toolName] !== undefined) return overrides[toolName];
  for (const [pattern, exp] of Object.entries(overrides)) {
    if (pattern.includes("*") && patternToRegExp(pattern).test(toolName)) return exp;
  }
  return server.exposure ?? "codemode";
}

/** MCP tool-result content to Pi content (middle truncation); delegates to `convertMcpContentBlocks`. */
export function convertToolContentBlocks(
  serverName: string,
  rawBlocks: readonly unknown[],
): ConvertedContent {
  return convertMcpContentBlocks(serverName, rawBlocks, { truncate: "middle", tempPrefix: "mcp-tool" });
}

export function createToolsFallback(
  pi: ExtensionAPI,
  host: EngineHost,
  opts?: { builtinSettleMs?: number; tasks?: TasksEngineApi },
): ToolsFallbackApi {
  const settleMs = opts?.builtinSettleMs ?? 120;
  const toolOwners = new Map<string, string>();
  const serverRegisteredNames = new Map<string, Set<string>>();
  const serverConfigs = new Map<string, ResolvedServer>();
  const definitions = new Map<string, ToolDefinition<TSchema, unknown>>();
  const listenDisposers = new Map<string, { client: ServerClient; dispose: () => void }>();
  let shutDown = false;

  const onAbort = () => void shutdown();
  host.signal?.addEventListener?.("abort", onAbort, { once: true });

  function builtinLoaded(): boolean {
    return pi.getAllTools().some((t) => t.sourceInfo?.path === "builtin:mcp");
  }

  function builtinOwnsServer(serverName: string, namespace: string, client?: ServerClient): boolean {
    if (
      client?.state.supportedVersions?.some((v) => v < "2026-07-28") &&
      builtinLoaded()
    ) {
      return true;
    }
    const sanitizedPrefix = `mcp__${sanitizeSegment(serverName)}__`;
    const nsPrefix = `${namespace}__`;
    const ownNames = new Set<string>();
    for (const set of serverRegisteredNames.values()) {
      for (const n of set) ownNames.add(n);
    }
    return pi.getAllTools().some(
      (t) =>
        !ownNames.has(t.name) &&
        (t.name.startsWith(nsPrefix) ||
          t.name.startsWith(sanitizedPrefix) ||
          (t.sourceInfo?.path === "builtin:mcp" &&
            t.name.startsWith("mcp__") &&
            sanitizedPrefix.startsWith(t.name.slice(0, Math.min(sanitizedPrefix.length, 40))))),
    );
  }

  async function fetchServerTools(client: ServerClient): Promise<McpToolDescriptor[]> {
    return paginateMcp(client, "tools/list", (res) => {
      const out: McpToolDescriptor[] = [];
      const list = Array.isArray(res.tools) ? res.tools : [];
      for (const raw of list) {
        if (!isRecord(raw) || typeof raw.name !== "string") continue;
        const schema = isRecord(raw.inputSchema)
          ? raw.inputSchema
          : { type: "object", properties: {} };
        const headerValidation = validateXMcpHeaders(schema);
        if (!headerValidation.valid) {
          host.log(
            "warn",
            `[${client.name}] Skipping tool "${raw.name}" with invalid x-mcp-header schema: ${headerValidation.reason}`,
          );
          continue;
        }
        out.push({
          name: raw.name,
          ...(typeof raw.title === "string" ? { title: raw.title } : {}),
          ...(typeof raw.description === "string" ? { description: raw.description } : {}),
          inputSchema: schema,
          ...(isRecord(raw.annotations)
            ? { annotations: raw.annotations as McpToolDescriptor["annotations"] }
            : {}),
        });
      }
      return out;
    }, {});
  }

  function registerServerTools(
    server: ResolvedServer,
    client: ServerClient,
    tools: readonly McpToolDescriptor[],
  ): void {
    if (shutDown) return;
    if (builtinOwnsServer(server.name, server.namespace, client)) return;

    const previous = serverRegisteredNames.get(server.name) ?? new Set<string>();
    const current = new Set<string>();
    const plainCandidates = [...new Set(tools.map((t) => t.name))].map((tName) =>
      createFallbackToolName(server.name, tName, () => false),
    );

    const namespaceObj = {
      name: server.namespace,
      aliases: [server.name],
      ...(server.description ? { description: server.description } : {}),
      ...(client.state.instructions ? { instructions: client.state.instructions } : {}),
    };

    for (const tool of tools) {
      const ownerKey = `${server.name}\0${tool.name}`;
      const regName = createFallbackToolName(server.name, tool.name, (candidate) => {
        const existingOwner = toolOwners.get(candidate);
        return (
          (existingOwner !== undefined && existingOwner !== ownerKey) ||
          current.has(candidate) ||
          plainCandidates.indexOf(candidate) !== plainCandidates.lastIndexOf(candidate)
        );
      });
      toolOwners.set(regName, ownerKey);
      current.add(regName);

      const exposure = resolveEffectiveExposure(server, tool.name);
      const parameters = Type.Unsafe<Record<string, unknown>>(tool.inputSchema as never);

      const def: ToolDefinition<TSchema, unknown> = {
        name: regName,
        label: `${server.name}/${tool.name}`,
        description: tool.description ?? tool.title ?? `MCP tool ${tool.name} on ${server.name}`,
        parameters,
        exposure,
        namespace: namespaceObj,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
          const liveClient = host.getClient(server.name);
          if (!liveClient) {
            throw new Error(`MCP server "${server.name}" is unavailable.`);
          }
          const rawResult = await liveClient.request<JsonObject>(
            "tools/call",
            {
              name: tool.name,
              arguments: isRecord(params) ? params : {},
            },
            { signal, timeoutMs: server.timeoutMs },
          );

          if (rawResult.resultType === "task") {
            const record = opts?.tasks?.trackCreatedTask?.(
              server.name,
              tool.name,
              rawResult as unknown as CreateTaskResult,
            );
            const summary = JSON.stringify(
              {
                resultType: "task",
                server: server.name,
                tool: tool.name,
                taskId: rawResult.taskId,
                status: rawResult.status,
                ...(rawResult.statusMessage ? { statusMessage: rawResult.statusMessage } : {}),
              },
              null,
              2,
            );
            return {
              content: [{ type: "text", text: summary }],
              details: record ?? rawResult,
            } as AgentToolResult<unknown>;
          }

          const blocks = Array.isArray(rawResult.content) ? rawResult.content : [];
          const converted = convertToolContentBlocks(server.name, blocks);
          const structured: JsonObject = {
            content: blocks,
            ...(rawResult.structuredContent !== undefined
              ? { structuredContent: rawResult.structuredContent }
              : {}),
            ...(typeof rawResult.isError === "boolean" ? { isError: rawResult.isError } : {}),
          };

          if (rawResult.isError === true) {
            const errMsg = converted.content
              .filter((b): b is TextContent => b.type === "text")
              .map((b) => b.text)
              .join("\n")
              .trim();
            throw new Error(errMsg || `Tool "${tool.name}" on "${server.name}" returned isError: true`);
          }

          return {
            content: converted.content,
            structuredContent: structured,
            details: {
              server: server.name,
              tool: tool.name,
              ...(converted.fullOutputPath ? { fullOutputPath: converted.fullOutputPath } : {}),
            },
          } as AgentToolResult<unknown>;
        },
      };

      definitions.set(regName, def);
      pi.registerTool(def as never);
    }

    serverRegisteredNames.set(server.name, current);
    for (const prevName of previous) {
      if (!current.has(prevName)) {
        const oldDef = definitions.get(prevName);
        if (oldDef) {
          pi.registerTool({ ...oldDef, exposure: "hidden" } as never);
        }
      }
    }
  }

  async function refreshTools(serverName: string): Promise<void> {
    if (shutDown) return;
    const server = serverConfigs.get(serverName);
    const client = host.getClient(serverName);
    if (!server || !client || !client.state.tools) return;
    if (builtinOwnsServer(server.name, server.namespace, client)) {
      deactivateServer(serverName);
      return;
    }
    const tools = await fetchServerTools(client);
    if (shutDown) return;
    registerServerTools(server, client, tools);
  }

  async function activateIfUnowned(server: ResolvedServer): Promise<boolean> {
    if (shutDown) return false;
    const client = host.getClient(server.name);
    if (!client || !client.state.tools) return false;
    serverConfigs.set(server.name, server);

    if (builtinOwnsServer(server.name, server.namespace, client)) return false;
    if (settleMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, settleMs);
        t.unref?.();
      });
    }
    if (shutDown || builtinOwnsServer(server.name, server.namespace, client)) return false;

    const liveClient = host.getClient(server.name);
    if (!liveClient) return false;

    const tools = await fetchServerTools(liveClient);
    if (shutDown || builtinOwnsServer(server.name, server.namespace, liveClient)) return false;

    registerServerTools(server, liveClient, tools);

    const existingLd = listenDisposers.get(server.name);
    if (liveClient.state.toolsListChanged && existingLd?.client !== liveClient) {
      existingLd?.dispose();
      liveClient.setListenInterest("tools", { toolsListChanged: true });
      const off = liveClient.onListenNotification((msg: JSONRPCNotification) => {
        if (msg.method === "notifications/tools/list_changed") {
          void refreshTools(server.name).catch((err) =>
            host.log(
              "warn",
              `tools/list refresh for ${server.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      });
      listenDisposers.set(server.name, {
        client: liveClient,
        dispose: () => {
          off();
          liveClient.setListenInterest("tools", {});
        },
      });
    }

    return true;
  }

  function deactivateServer(serverName: string): void {
    listenDisposers.get(serverName)?.dispose();
    listenDisposers.delete(serverName);
    serverConfigs.delete(serverName);
    const names = serverRegisteredNames.get(serverName);
    if (names && names.size > 0) {
      for (const name of names) {
        const def = definitions.get(name);
        if (def) {
          pi.registerTool({ ...def, exposure: "hidden" } as never);
        }
      }
      serverRegisteredNames.set(serverName, new Set());
    }
  }

  async function shutdown(): Promise<void> {
    if (shutDown) return;
    shutDown = true;
    host.signal?.removeEventListener?.("abort", onAbort);
    for (const serverName of [...serverRegisteredNames.keys()]) {
      deactivateServer(serverName);
    }
    for (const ld of listenDisposers.values()) {
      try {
        ld.dispose();
      } catch {
        /* ignore */
      }
    }
    listenDisposers.clear();
  }

  return {
    activateIfUnowned,
    deactivateServer,
    shutdown,
  };
}
