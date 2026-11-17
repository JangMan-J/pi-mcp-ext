/**
 * MCP 2026-07-28 Prompts & Argument Completion (`server/prompts.md`, `server/utilities/completion.md`).
 *
 * Implements paginated `prompts/list`, `notifications/prompts/list_changed` refresh over
 * `subscriptions/listen`, `prompts/get` message resolution, `completion/complete` (`ref/prompt`
 * and `ref/resource`) with bounded LRU caching + in-flight coalescing, and slash-command argument
 * parsing/autocompletion.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import { writePrivateTempFile } from "./temp-files.ts";
import { ErrorCode, McpRpcError, McpTransportError } from "./types.ts";
import type {
  EngineHost,
  JSONRPCNotification,
  JsonObject,
  McpLogLevel,
  McpLogMessage,
  ServerClient,
} from "./types.ts";

export interface PromptArgument {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
}

export interface PromptDescriptor {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
}

export interface PromptGetResult {
  description?: string;
  messages: Array<{ role: "user" | "assistant"; content: JsonObject }>;
  renderedText: string;
  images: ImageContent[];
}

export type CompletionReference =
  | { type: "ref/prompt"; name: string }
  | { type: "ref/resource"; uri: string };

export interface CompletionOutcome {
  values: string[];
  total?: number;
  hasMore: boolean;
}

type LogOpts = { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void };

export interface PromptsEngineApi {
  serverReady(server: string): Promise<PromptDescriptor[]>;
  serverRemoved?(server: string): void;
  list(server: string, opts?: LogOpts): Promise<PromptDescriptor[]>;
  cachedPrompts(): Array<{ server: string; prompt: PromptDescriptor }>;
  get(
    server: string,
    name: string,
    args?: Record<string, string>,
    opts?: LogOpts,
  ): Promise<PromptGetResult>;
  complete(
    server: string,
    ref: CompletionReference,
    argument: { name: string; value: string },
    contextArguments?: Record<string, string>,
    opts?: LogOpts,
  ): Promise<CompletionOutcome>;
  onPromptsChanged(listener: (server: string, prompts: PromptDescriptor[]) => void): () => void;
  shutdown(): Promise<void>;
}

const COMPLETION_CACHE_MAX = 256;
const COMPLETION_CACHE_TTL_MS = 15_000;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeCloseTags(value: string): string {
  return value.replace(/<\/(mcp_[a-zA-Z0-9_]*)/gi, "<\\/$1");
}

function isRecord(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toReqOpts(opts?: LogOpts) {
  return opts?.logLevel || opts?.onLog
    ? {
        ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
        ...(opts.onLog ? { onLog: opts.onLog } : {}),
      }
    : undefined;
}

/**
 * Parse slash-command arguments like `lang=python focus="error handling"` (or a bare positional
 * value mapped to the first argument) and compute completion state for the trailing token.
 */
export function parseSlashPromptInput(
  raw: string,
  promptArgs?: readonly PromptArgument[],
): {
  resolved: Record<string, string>;
  completing?: {
    name: string;
    value: string;
    replacePrefix: string;
  };
} {
  const resolved: Record<string, string> = {};
  const argsList = promptArgs ?? [];
  const tokenRe = /([A-Za-z0-9_.-]+)=(?:"([^"]*)"|'([^']*)'|(\S*))|(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  const tokens: Array<{
    key?: string;
    value: string;
    start: number;
    end: number;
    raw: string;
  }> = [];

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({
        key: m[1],
        value: m[2] ?? m[3] ?? m[4] ?? "",
        start: m.index,
        end: m.index + m[0].length,
        raw: m[0],
      });
    } else {
      tokens.push({
        value: m[5] ?? m[6] ?? m[7] ?? "",
        start: m.index,
        end: m.index + m[0].length,
        raw: m[0],
      });
    }
  }

  let positionalIdx = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.key) {
      resolved[tok.key] = tok.value;
    } else if (argsList[positionalIdx]) {
      resolved[argsList[positionalIdx].name] = tok.value;
      positionalIdx += 1;
    }
  }

  const endsWithSpace = raw.length === 0 || /\s$/.test(raw);
  if (endsWithSpace) {
    const nextArg = argsList.find((a) => !(a.name in resolved));
    if (nextArg) {
      return {
        resolved,
        completing: {
          name: nextArg.name,
          value: "",
          replacePrefix: raw,
        },
      };
    }
    return { resolved };
  }

  const last = tokens[tokens.length - 1];
  if (!last) return { resolved };

  if (last.key) {
    const contextCopy = { ...resolved };
    delete contextCopy[last.key];
    return {
      resolved: contextCopy,
      completing: {
        name: last.key,
        value: last.value,
        replacePrefix: `${raw.slice(0, last.start)}${last.key}=`,
      },
    };
  }

  // Bare trailing token: either matches an argument name prefix (`lan` -> `language=`) or positional value
  const matchingKey = argsList.find((a) => a.name.startsWith(last.value) && !(a.name in resolved));
  if (matchingKey && argsList.length > 1) {
    return {
      resolved,
      completing: {
        name: matchingKey.name,
        value: "",
        replacePrefix: `${raw.slice(0, last.start)}${matchingKey.name}=`,
      },
    };
  }

  const targetArg = argsList[Math.max(0, positionalIdx - 1)] ?? argsList[0];
  if (targetArg) {
    const contextCopy = { ...resolved };
    delete contextCopy[targetArg.name];
    return {
      resolved: contextCopy,
      completing: {
        name: targetArg.name,
        value: last.value,
        replacePrefix: `${raw.slice(0, last.start)}${argsList.length > 1 ? `${targetArg.name}=` : ""}`,
      },
    };
  }

  return { resolved };
}

function renderPromptMessages(
  server: string,
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: JsonObject }>,
): { renderedText: string; images: ImageContent[] } {
  const lines: string[] = [];
  const images: ImageContent[] = [];

  for (const msg of messages) {
    const prefix = msg.role === "assistant" ? "[Assistant context]\n" : "";
    const c = msg.content;
    switch (c.type) {
      case "text": {
        if (typeof c.text === "string") {
          lines.push(`${prefix}${c.text}`);
        }
        break;
      }
      case "image": {
        if (typeof c.data === "string" && typeof c.mimeType === "string") {
          images.push({ type: "image", data: c.data, mimeType: c.mimeType });
          if (prefix) lines.push(`${prefix}[Attached image (${c.mimeType})]`);
        }
        break;
      }
      case "audio": {
        if (typeof c.data === "string") {
          const mime = typeof c.mimeType === "string" ? c.mimeType : "audio/wav";
          const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "wav";
          try {
            const file = writePrivateTempFile("mcp-prompt-audio", ext, Buffer.from(c.data, "base64"));
            lines.push(`${prefix}[Audio content (${mime}) saved to ${file}]`);
          } catch {
            lines.push(`${prefix}[Audio content (${mime})]`);
          }
        }
        break;
      }
      case "resource_link": {
        const uri = typeof c.uri === "string" ? c.uri : "";
        const desc = typeof c.description === "string" ? ` — ${c.description}` : "";
        lines.push(
          `${prefix}[MCP resource link on "${server}": ${uri}${desc} (read with mcp_resources action="read")]`,
        );
        break;
      }
      case "resource": {
        const res = isRecord(c.resource) ? c.resource : {};
        const uri = typeof res.uri === "string" ? res.uri : "resource";
        if (typeof res.text === "string") {
          lines.push(
            `${prefix}<mcp_prompt_resource server="${escapeAttr(server)}" uri="${escapeAttr(uri)}">\n${escapeCloseTags(res.text)}\n</mcp_prompt_resource>`,
          );
        } else if (typeof res.blob === "string") {
          const mime = typeof res.mimeType === "string" ? res.mimeType : "application/octet-stream";
          if (/^image\/(png|jpeg|jpg|gif|webp)$/i.test(mime)) {
            images.push({ type: "image", data: res.blob, mimeType: mime });
          } else {
            lines.push(`${prefix}[Embedded binary resource ${uri} (${mime})]`);
          }
        }
        break;
      }
      default:
        lines.push(`${prefix}${JSON.stringify(c)}`);
        break;
    }
  }

  return { renderedText: lines.join("\n\n"), images };
}

export function createPromptsEngine(host: EngineHost): PromptsEngineApi {
  const promptCache = new Map<string, PromptDescriptor[]>();
  const inflightLists = new Map<string, Promise<PromptDescriptor[]>>();
  const listenDisposers = new Map<string, { client: ServerClient; dispose: () => void }>();
  const changeListeners = new Set<(server: string, prompts: PromptDescriptor[]) => void>();
  const completionCache = new Map<string, { expiresAt: number; value: CompletionOutcome }>();
  const inflightCompletions = new Map<string, Promise<CompletionOutcome>>();
  let shutDown = false;

  const onAbort = () => void shutdown();
  host.signal?.addEventListener?.("abort", onAbort, { once: true });

  function emitChanged(server: string, prompts: PromptDescriptor[]): void {
    for (const fn of [...changeListeners]) {
      try {
        fn(server, prompts);
      } catch {
        /* ignore */
      }
    }
  }

  function ensureListen(server: string, client: ServerClient): void {
    const existing = listenDisposers.get(server);
    if (existing?.client === client) return;
    existing?.dispose();
    listenDisposers.delete(server);
    if (!client.state.promptsListChanged) return;
    client.setListenInterest("prompts", { promptsListChanged: true });
    const off = client.onListenNotification((msg: JSONRPCNotification) => {
      if (msg.method === "notifications/prompts/list_changed") {
        promptCache.delete(server);
        void list(server).catch((err) =>
          host.log("warn", `prompts/list refresh for ${server} failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    });
    listenDisposers.set(server, {
      client,
      dispose: () => {
        off();
        client.setListenInterest("prompts", {});
      },
    });
  }

  async function fetchPrompts(
    server: string,
    client: ServerClient,
    opts?: LogOpts,
  ): Promise<PromptDescriptor[]> {
    const out: PromptDescriptor[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    const reqOpts = toReqOpts(opts);
    for (let page = 0; page < 1_000; page += 1) {
      const res = await client.request<JsonObject>(
        "prompts/list",
        cursor ? { cursor } : {},
        reqOpts,
      );
      const raw = Array.isArray(res.prompts) ? res.prompts : [];
      for (const item of raw) {
        if (!isRecord(item) || typeof item.name !== "string") continue;
        const args = Array.isArray(item.arguments)
          ? item.arguments
              .filter(isRecord)
              .filter((a) => typeof a.name === "string")
              .map((a) => ({
                name: a.name as string,
                ...(typeof a.title === "string" ? { title: a.title } : {}),
                ...(typeof a.description === "string" ? { description: a.description } : {}),
                ...(typeof a.required === "boolean" ? { required: a.required } : {}),
              }))
          : undefined;
        out.push({
          name: item.name,
          ...(typeof item.title === "string" ? { title: item.title } : {}),
          ...(typeof item.description === "string" ? { description: item.description } : {}),
          ...(args ? { arguments: args } : {}),
        });
      }
      if (typeof res.nextCursor !== "string" || !res.nextCursor) {
        promptCache.set(server, out);
        emitChanged(server, out);
        return out;
      }
      if (seen.has(res.nextCursor)) {
        throw new McpTransportError("protocol", `Duplicate pagination cursor on prompts/list for "${server}"`);
      }
      seen.add(res.nextCursor);
      cursor = res.nextCursor;
    }
    throw new McpTransportError("protocol", `Pagination limit (1000 pages) exceeded on prompts/list for "${server}"`);
  }

  async function list(server: string, opts?: LogOpts): Promise<PromptDescriptor[]> {
    const client = host.getClient(server);
    if (!client) throw new Error(`Unknown or not-ready MCP server: ${server}`);
    ensureListen(server, client);
    if (opts?.logLevel || opts?.onLog) {
      return fetchPrompts(server, client, opts);
    }
    const cached = promptCache.get(server);
    if (cached && client.state.promptsListChanged) return cached;
    const pending = inflightLists.get(server);
    if (pending) return pending;
    const promise = fetchPrompts(server, client).finally(() => {
      if (inflightLists.get(server) === promise) inflightLists.delete(server);
    });
    inflightLists.set(server, promise);
    return promise;
  }

  async function serverReady(server: string): Promise<PromptDescriptor[]> {
    if (shutDown) return [];
    const client = host.getClient(server);
    if (!client || !client.state.prompts) return [];
    promptCache.delete(server);
    return list(server);
  }

  function serverRemoved(server: string): void {
    const ld = listenDisposers.get(server);
    if (ld) {
      try {
        ld.dispose();
      } catch {
        /* ignore */
      }
      listenDisposers.delete(server);
    }
    promptCache.delete(server);
    inflightLists.delete(server);
  }

  async function get(
    server: string,
    name: string,
    args?: Record<string, string>,
    opts?: LogOpts,
  ): Promise<PromptGetResult> {
    const client = host.getClient(server);
    if (!client) throw new Error(`Unknown or not-ready MCP server: ${server}`);
    const params: JsonObject = {
      name,
      ...(args && Object.keys(args).length > 0 ? { arguments: args } : {}),
    };
    const res = await client.request<JsonObject>("prompts/get", params, toReqOpts(opts));
    const rawMessages = Array.isArray(res.messages) ? res.messages : [];
    const messages: Array<{ role: "user" | "assistant"; content: JsonObject }> = [];
    for (const m of rawMessages) {
      if (!isRecord(m) || (m.role !== "user" && m.role !== "assistant") || !isRecord(m.content)) {
        continue;
      }
      messages.push({ role: m.role, content: m.content });
    }
    const { renderedText, images } = renderPromptMessages(server, messages);
    return {
      ...(typeof res.description === "string" ? { description: res.description } : {}),
      messages,
      renderedText,
      images,
    };
  }

  async function complete(
    server: string,
    ref: CompletionReference,
    argument: { name: string; value: string },
    contextArguments?: Record<string, string>,
    opts?: LogOpts,
  ): Promise<CompletionOutcome> {
    const client = host.getClient(server);
    if (!client) throw new Error(`Unknown or not-ready MCP server: ${server}`);
    if (!client.state.completions) {
      return { values: [], hasMore: false };
    }

    const cacheKey = JSON.stringify([server, ref, argument, contextArguments ?? {}]);
    if (!opts?.logLevel && !opts?.onLog) {
      const hit = completionCache.get(cacheKey);
      if (hit && Date.now() < hit.expiresAt) {
        return hit.value;
      }
      const inflight = inflightCompletions.get(cacheKey);
      if (inflight) return inflight;
    }

    const run = (async (): Promise<CompletionOutcome> => {
      try {
        const params: JsonObject = {
          ref: ref as unknown as JsonObject,
          argument,
          ...(contextArguments && Object.keys(contextArguments).length > 0
            ? { context: { arguments: contextArguments } }
            : {}),
        };
        const res = await client.request<JsonObject>("completion/complete", params, toReqOpts(opts));
        const comp = isRecord(res.completion) ? res.completion : {};
        const values = Array.isArray(comp.values)
          ? comp.values.filter((v): v is string => typeof v === "string").slice(0, 100)
          : [];
        const outcome: CompletionOutcome = {
          values,
          ...(typeof comp.total === "number" ? { total: comp.total } : {}),
          hasMore: comp.hasMore === true,
        };
        if (!opts?.logLevel && !opts?.onLog) {
          if (completionCache.size >= COMPLETION_CACHE_MAX) {
            const oldest = completionCache.keys().next().value;
            if (oldest !== undefined) completionCache.delete(oldest);
          }
          completionCache.set(cacheKey, {
            expiresAt: Date.now() + COMPLETION_CACHE_TTL_MS,
            value: outcome,
          });
        }
        return outcome;
      } catch (err) {
        if (err instanceof McpRpcError && err.code === ErrorCode.MethodNotFound) {
          return { values: [], hasMore: false };
        }
        throw err;
      }
    })().finally(() => {
      inflightCompletions.delete(cacheKey);
    });

    if (!opts?.logLevel && !opts?.onLog) {
      inflightCompletions.set(cacheKey, run);
    }
    return run;
  }

  async function shutdown(): Promise<void> {
    if (shutDown) return;
    shutDown = true;
    host.signal?.removeEventListener?.("abort", onAbort);
    for (const ld of listenDisposers.values()) {
      try {
        ld.dispose();
      } catch {
        /* ignore */
      }
    }
    listenDisposers.clear();
    inflightLists.clear();
    inflightCompletions.clear();
    completionCache.clear();
  }

  return {
    serverReady,
    serverRemoved,
    list,
    cachedPrompts: () => {
      const out: Array<{ server: string; prompt: PromptDescriptor }> = [];
      for (const [server, prompts] of promptCache) {
        if (!host.getClient(server)) continue;
        for (const prompt of prompts) out.push({ server, prompt });
      }
      return out;
    },
    get,
    complete,
    onPromptsChanged: (listener) => {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    shutdown,
  };
}
