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
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type {
  EngineHost,
  JSONRPCNotification,
  JsonObject,
  McpExposure,
  ResolvedServer,
  ServerClient,
} from "./types.ts";

const MAX_INLINE_TEXT_BYTES = 20 * 1024;

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
  if (!collides(base)) return base;
  const suffix = createHash("sha256").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 6);
  return `${base}_${suffix}`;
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

function middleTruncateText(text: string): { text: string; fullOutputPath?: string } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_INLINE_TEXT_BYTES) return { text };
  const half = Math.floor(MAX_INLINE_TEXT_BYTES / 2);
  const head = bytes.subarray(0, half).toString("utf8");
  const tail = bytes.subarray(bytes.length - half).toString("utf8");
  const removedChars = Math.max(1, text.length - head.length - tail.length);
  try {
    const file = join(
      tmpdir(),
      `pi-mcp-tool-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`,
    );
    writeFileSync(file, text, "utf8");
    return {
      text: `${head}\n…${removedChars} chars truncated (full output saved to ${file})…\n${tail}`,
      fullOutputPath: file,
    };
  } catch {
    return { text: `${head}\n…${removedChars} chars truncated…\n${tail}` };
  }
}

export function convertToolContentBlocks(
  serverName: string,
  rawBlocks: readonly unknown[],
): { content: Array<TextContent | ImageContent>; fullOutputPath?: string } {
  const content: Array<TextContent | ImageContent> = [];
  let savedPath: string | undefined;

  for (const raw of rawBlocks) {
    if (!isRecord(raw) || typeof raw.type !== "string") continue;
    switch (raw.type) {
      case "text": {
        if (typeof raw.text === "string") {
          const trunc = middleTruncateText(raw.text);
          if (trunc.fullOutputPath && !savedPath) savedPath = trunc.fullOutputPath;
          content.push({ type: "text", text: trunc.text });
        }
        break;
      }
      case "image": {
        if (typeof raw.data === "string" && typeof raw.mimeType === "string") {
          content.push({ type: "image", data: raw.data, mimeType: raw.mimeType });
        }
        break;
      }
      case "audio": {
        if (typeof raw.data === "string") {
          const mime = typeof raw.mimeType === "string" ? raw.mimeType : "audio/wav";
          const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "wav";
          try {
            const file = join(
              tmpdir(),
              `pi-mcp-audio-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`,
            );
            writeFileSync(file, Buffer.from(raw.data, "base64"));
            content.push({ type: "text", text: `[Audio output (${mime}) saved to ${file}]` });
          } catch {
            content.push({ type: "text", text: `[Audio output (${mime})]` });
          }
        }
        break;
      }
      case "resource_link": {
        const uri = typeof raw.uri === "string" ? raw.uri : "";
        const desc = typeof raw.description === "string" ? ` — ${raw.description}` : "";
        content.push({
          type: "text",
          text: `[Resource link on MCP server "${serverName}": ${uri}${desc} (read via mcp_resources action="read")]`,
        });
        break;
      }
      case "resource": {
        const res = isRecord(raw.resource) ? raw.resource : {};
        const uri = typeof res.uri === "string" ? res.uri : "";
        if (typeof res.text === "string") {
          const trunc = middleTruncateText(res.text);
          if (trunc.fullOutputPath && !savedPath) savedPath = trunc.fullOutputPath;
          content.push({ type: "text", text: trunc.text });
        } else if (typeof res.blob === "string") {
          const mime = typeof res.mimeType === "string" ? res.mimeType : "application/octet-stream";
          if (/^image\/(png|jpeg|jpg|gif|webp)$/i.test(mime)) {
            content.push({ type: "image", data: res.blob, mimeType: mime });
          } else {
            try {
              const file = join(
                tmpdir(),
                `pi-mcp-blob-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bin`,
              );
              writeFileSync(file, Buffer.from(res.blob, "base64"));
              content.push({
                type: "text",
                text: `[Binary resource "${uri}" (${mime}) saved to ${file}]`,
              });
            } catch {
              content.push({ type: "text", text: `[Binary resource "${uri}" (${mime})]` });
            }
          }
        }
        break;
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return { content, ...(savedPath ? { fullOutputPath: savedPath } : {}) };
}

export function createToolsFallback(
  pi: ExtensionAPI,
  host: EngineHost,
  opts?: { builtinSettleMs?: number },
): ToolsFallbackApi {
  const settleMs = opts?.builtinSettleMs ?? 120;
  const toolOwners = new Map<string, string>();
  const serverRegisteredNames = new Map<string, Set<string>>();
  const serverConfigs = new Map<string, ResolvedServer>();
  const definitions = new Map<string, ToolDefinition<TSchema, unknown>>();
  const listenDisposers = new Map<string, () => void>();
  let shutDown = false;

  const onAbort = () => void shutdown();
  host.signal?.addEventListener?.("abort", onAbort, { once: true });

  function builtinOwnsServer(namespace: string): boolean {
    const prefix = `${namespace}__`;
    const ownNames = new Set<string>();
    for (const set of serverRegisteredNames.values()) {
      for (const n of set) ownNames.add(n);
    }
    return pi.getAllTools().some((t) => t.name.startsWith(prefix) && !ownNames.has(t.name));
  }

  async function fetchServerTools(client: ServerClient): Promise<McpToolDescriptor[]> {
    const out: McpToolDescriptor[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 32; page += 1) {
      const res = await client.request<JsonObject>("tools/list", cursor ? { cursor } : {});
      const list = Array.isArray(res.tools) ? res.tools : [];
      for (const raw of list) {
        if (!isRecord(raw) || typeof raw.name !== "string") continue;
        const schema = isRecord(raw.inputSchema)
          ? raw.inputSchema
          : { type: "object", properties: {} };
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
      if (typeof res.nextCursor !== "string" || !res.nextCursor || seen.has(res.nextCursor)) {
        break;
      }
      seen.add(res.nextCursor);
      cursor = res.nextCursor;
    }
    return out;
  }

  function registerServerTools(
    server: ResolvedServer,
    client: ServerClient,
    tools: readonly McpToolDescriptor[],
  ): void {
    if (shutDown) return;
    if (builtinOwnsServer(server.namespace)) return;

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
        exposure: exposure === "codemode" ? "deferred" : exposure,
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
    if (builtinOwnsServer(server.namespace)) {
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

    if (builtinOwnsServer(server.namespace)) return false;
    if (settleMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, settleMs);
        t.unref?.();
      });
    }
    if (shutDown || builtinOwnsServer(server.namespace)) return false;

    const liveClient = host.getClient(server.name);
    if (!liveClient) return false;

    const tools = await fetchServerTools(liveClient);
    if (shutDown || builtinOwnsServer(server.namespace)) return false;

    registerServerTools(server, liveClient, tools);

    if (liveClient.state.toolsListChanged && !listenDisposers.has(server.name)) {
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
      listenDisposers.set(server.name, () => {
        off();
        liveClient.setListenInterest("tools", {});
      });
    }

    return true;
  }

  function deactivateServer(serverName: string): void {
    listenDisposers.get(serverName)?.();
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
    for (const dispose of listenDisposers.values()) {
      try {
        dispose();
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
