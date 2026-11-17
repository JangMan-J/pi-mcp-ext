/**
 * MCP 2026-07-28 Resources & Live Resource Subscriptions (`server/resources.md`, `basic/patterns/subscriptions.md`).
 *
 * Provides paginated `resources/list`, `resources/templates/list`, `resources/read`, optional
 * `resources/directory/read`, and reactive `resourceSubscriptions` / `resourcesListChanged` over
 * the shared per-server `subscriptions/listen` stream.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { writePrivateTempFile } from "./temp-files.ts";
import {
  CUSTOM_RESOURCE_SUBSCRIPTIONS,
  ErrorCode,
  MESSAGE_RESOURCE,
  McpRpcError,
  McpTransportError,
} from "./types.ts";
import type {
  EngineHost,
  JSONRPCNotification,
  JsonObject,
  McpLogLevel,
  McpLogMessage,
  ServerClient,
} from "./types.ts";

export interface McpResourceItem {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: JsonObject;
  _meta?: JsonObject;
}

export interface McpResourceTemplateItem {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: JsonObject;
  _meta?: JsonObject;
}

export interface ResourceSubscriptionRecord {
  server: string;
  uri: string;
  holdSettle: boolean;
  active: boolean;
  honored: boolean;
}

type ResourceSubEntry =
  | { op: "upsert"; server: string; uri: string; holdSettle: boolean }
  | { op: "remove"; server: string; uri: string };

type LogOpts = { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void };

export interface ResourcesEngineApi {
  restore(branch: readonly unknown[]): void;
  serverReady(server: string): void;
  serverRemoved?(server: string): void;
  flushPending?(): void;
  list(
    server: string,
    cursor?: string,
    opts?: LogOpts,
  ): Promise<{ resources: McpResourceItem[]; nextCursor?: string }>;
  templates(
    server: string,
    cursor?: string,
    opts?: LogOpts,
  ): Promise<{ resourceTemplates: McpResourceTemplateItem[]; nextCursor?: string }>;
  read(
    server: string,
    uri: string,
    opts?: LogOpts,
  ): Promise<{
    contents: JsonObject[];
    blocks: Array<TextContent | ImageContent>;
  }>;
  directory(
    server: string,
    uri: string,
    cursor?: string,
    opts?: LogOpts,
  ): Promise<{ resources: McpResourceItem[]; nextCursor?: string }>;
  subscribe(server: string, uri: string, holdSettle?: boolean): ResourceSubscriptionRecord;
  unsubscribe(server: string, uri: string): boolean;
  subscriptions(server?: string): ResourceSubscriptionRecord[];
  holdsSettle(): boolean;
  activeWatches(): number;
  onWake(listener: () => void): () => void;
  onStateChange(listener: () => void): () => void;
  shutdown(): Promise<void>;
}

function isRecord(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isMcpAppResource(uri: string, mimeType?: string): boolean {
  if (uri.toLowerCase().startsWith("ui://")) return true;
  if (mimeType && mimeType.toLowerCase().includes("profile=mcp-app")) return true;
  return false;
}

function stripResourceIcons<T extends JsonObject>(raw: T): T {
  const clone: JsonObject = { ...raw };
  delete clone.icons;
  return clone as T;
}

function toReqOpts(opts?: LogOpts) {
  return opts?.logLevel || opts?.onLog
    ? {
        ...(opts.logLevel ? { logLevel: opts.logLevel } : {}),
        ...(opts.onLog ? { onLog: opts.onLog } : {}),
      }
    : undefined;
}

function extFromMime(mimeType?: string): string {
  if (!mimeType) return "bin";
  const clean = mimeType.split(";")[0].trim().toLowerCase();
  const slash = clean.indexOf("/");
  const sub = slash >= 0 ? clean.slice(slash + 1) : clean;
  const safe = sub.replace(/[^a-z0-9.+-]/g, "");
  return safe || "bin";
}

export function convertResourceContentsToBlocks(
  server: string,
  contents: readonly JsonObject[],
): Array<TextContent | ImageContent> {
  const blocks: Array<TextContent | ImageContent> = [];
  for (const item of contents) {
    const uri = typeof item.uri === "string" ? item.uri : "";
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
    if (typeof item.text === "string") {
      const truncated = truncateHead(item.text, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      let text = truncated.content;
      if (truncated.truncated) {
        try {
          const file = writePrivateTempFile("mcp-resource", "txt", item.text);
          text += `\n[truncated: full resource written to ${file}]`;
        } catch {
          text += "\n[truncated]";
        }
      }
      blocks.push({ type: "text", text });
      continue;
    }
    if (typeof item.blob === "string") {
      if (mimeType && /^image\/(png|jpeg|jpg|gif|webp)$/i.test(mimeType.split(";")[0].trim())) {
        blocks.push({
          type: "image",
          data: item.blob,
          mimeType: mimeType.split(";")[0].trim(),
        });
        continue;
      }
      try {
        const bytes = Buffer.from(item.blob, "base64");
        const file = writePrivateTempFile("mcp-resource", extFromMime(mimeType), bytes);
        blocks.push({
          type: "text",
          text: `Binary resource "${uri}" from MCP server "${server}" (${mimeType ?? "application/octet-stream"}, ${bytes.length} bytes) saved to ${file}`,
        });
      } catch {
        blocks.push({
          type: "text",
          text: `Binary resource "${uri}" from MCP server "${server}" (${mimeType ?? "application/octet-stream"})`,
        });
      }
    }
  }
  return blocks;
}

function timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, Math.max(0, ms));
  (t as { unref?: () => void }).unref?.();
  return t;
}

export function createResourcesEngine(
  host: EngineHost,
  opts?: { batchWindowMs?: number },
): ResourcesEngineApi {
  const batchWindowMs = opts?.batchWindowMs ?? 75;
  const watched = new Map<string, { server: string; uri: string; holdSettle: boolean }>();
  const connections = new Map<
    string,
    { client: ServerClient; honoredUris: Set<string>; off: Array<() => void> }
  >();
  const pendingUpdates = new Map<string, { server: string; uris: Set<string>; listChanged: boolean }>();
  const wakeListeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let shutDown = false;

  const subKey = (server: string, uri: string) => `${server}\0${uri}`;
  const emitState = () => {
    for (const fn of [...stateListeners]) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  };
  const onAbort = () => void shutdown();
  host.signal?.addEventListener?.("abort", onAbort, { once: true });

  function flushBatch(): void {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
    if (pendingUpdates.size === 0) return;
    const items = [...pendingUpdates.values()];
    pendingUpdates.clear();

    const parts: string[] = [];
    const details: Array<{ server: string; updatedUris: string[]; listChanged: boolean }> = [];
    for (const entry of items) {
      const uris = [...entry.uris];
      details.push({ server: entry.server, updatedUris: uris, listChanged: entry.listChanged });
      if (entry.listChanged) {
        parts.push(`<mcp_resources_list_changed server="${escapeAttr(entry.server)}" />`);
      }
      for (const uri of uris) {
        parts.push(
          `<mcp_resource_updated server="${escapeAttr(entry.server)}" uri="${escapeAttr(uri)}" />`,
        );
      }
    }
    host.wake(MESSAGE_RESOURCE, parts.join("\n"), { resources: details });
    for (const fn of [...wakeListeners]) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  function enqueueUpdate(server: string, uri?: string, listChanged = false): void {
    if (shutDown) return;
    let entry = pendingUpdates.get(server);
    if (!entry) {
      entry = { server, uris: new Set<string>(), listChanged: false };
      pendingUpdates.set(server, entry);
    }
    if (uri) entry.uris.add(uri);
    if (listChanged) entry.listChanged = true;
    batchTimer ??= timer(flushBatch, batchWindowMs);
  }

  function syncServerInterest(server: string): void {
    const conn = connections.get(server);
    if (!conn) return;
    const uris: string[] = [];
    for (const rec of watched.values()) {
      if (rec.server === server) uris.push(rec.uri);
    }
    if (uris.length === 0) {
      conn.client.setListenInterest("resources", {});
      return;
    }
    conn.client.setListenInterest("resources", {
      resourceSubscriptions: uris,
      ...(conn.client.state.resourcesListChanged ? { resourcesListChanged: true } : {}),
    });
  }

  function attachServer(server: string): void {
    if (shutDown) return;
    const client = host.getClient(server);
    if (!client) return;
    const existing = connections.get(server);
    if (existing?.client !== client) {
      existing?.off.forEach((fn) => fn());
      const conn = {
        client,
        honoredUris: new Set<string>(),
        off: [] as Array<() => void>,
      };
      conn.off.push(
        client.onListenState((honored) => {
          conn.honoredUris = new Set(honored?.resourceSubscriptions ?? []);
          emitState();
        }),
      );
      conn.off.push(
        client.onListenNotification((msg: JSONRPCNotification) => {
          if (msg.method === "notifications/resources/updated") {
            const uri = typeof msg.params?.uri === "string" ? msg.params.uri : undefined;
            if (uri && watched.has(subKey(server, uri))) {
              enqueueUpdate(server, uri, false);
            }
          } else if (msg.method === "notifications/resources/list_changed") {
            enqueueUpdate(server, undefined, true);
          }
        }),
      );
      connections.set(server, conn);
    }
    syncServerInterest(server);
    emitState();
  }

  function requireClient(server: string): ServerClient {
    const client = host.getClient(server);
    if (!client) throw new Error(`Unknown or not-ready MCP server: ${server}`);
    return client;
  }

  async function list(
    server: string,
    cursor?: string,
    opts?: LogOpts,
  ): Promise<{ resources: McpResourceItem[]; nextCursor?: string }> {
    const client = requireClient(server);
    const reqOpts = toReqOpts(opts);
    if (cursor !== undefined) {
      const page = await client.request<JsonObject>("resources/list", { cursor }, reqOpts);
      const rawList = Array.isArray(page.resources) ? page.resources : [];
      const resources = rawList
        .filter(isRecord)
        .filter((r) => typeof r.uri === "string" && !isMcpAppResource(r.uri, r.mimeType as string | undefined))
        .map((r) => stripResourceIcons(r) as unknown as McpResourceItem);
      return {
        resources,
        ...(typeof page.nextCursor === "string" ? { nextCursor: page.nextCursor } : {}),
      };
    }

    const all: McpResourceItem[] = [];
    const seen = new Set<string>();
    let next: string | undefined;
    for (let i = 0; i < 1_000; i += 1) {
      const page = await client.request<JsonObject>(
        "resources/list",
        next ? { cursor: next } : {},
        reqOpts,
      );
      const rawList = Array.isArray(page.resources) ? page.resources : [];
      for (const item of rawList) {
        if (!isRecord(item) || typeof item.uri !== "string") continue;
        if (isMcpAppResource(item.uri, item.mimeType as string | undefined)) continue;
        all.push(stripResourceIcons(item) as unknown as McpResourceItem);
      }
      if (typeof page.nextCursor !== "string" || !page.nextCursor) {
        return { resources: all };
      }
      if (seen.has(page.nextCursor)) {
        throw new McpTransportError("protocol", `Duplicate pagination cursor on resources/list for "${server}"`);
      }
      seen.add(page.nextCursor);
      next = page.nextCursor;
    }
    throw new McpTransportError("protocol", `Pagination limit (1000 pages) exceeded on resources/list for "${server}"`);
  }

  async function templates(
    server: string,
    cursor?: string,
    opts?: LogOpts,
  ): Promise<{ resourceTemplates: McpResourceTemplateItem[]; nextCursor?: string }> {
    const client = requireClient(server);
    const reqOpts = toReqOpts(opts);
    try {
      if (cursor !== undefined) {
        const page = await client.request<JsonObject>("resources/templates/list", { cursor }, reqOpts);
        const rawList = Array.isArray(page.resourceTemplates) ? page.resourceTemplates : [];
        return {
          resourceTemplates: rawList
            .filter(isRecord)
            .map((t) => stripResourceIcons(t) as unknown as McpResourceTemplateItem),
          ...(typeof page.nextCursor === "string" ? { nextCursor: page.nextCursor } : {}),
        };
      }
      const all: McpResourceTemplateItem[] = [];
      const seen = new Set<string>();
      let next: string | undefined;
      for (let i = 0; i < 1_000; i += 1) {
        const page = await client.request<JsonObject>(
          "resources/templates/list",
          next ? { cursor: next } : {},
          reqOpts,
        );
        const rawList = Array.isArray(page.resourceTemplates) ? page.resourceTemplates : [];
        for (const item of rawList) {
          if (isRecord(item) && typeof item.uriTemplate === "string") {
            all.push(stripResourceIcons(item) as unknown as McpResourceTemplateItem);
          }
        }
        if (typeof page.nextCursor !== "string" || !page.nextCursor) {
          return { resourceTemplates: all };
        }
        if (seen.has(page.nextCursor)) {
          throw new McpTransportError("protocol", `Duplicate pagination cursor on resources/templates/list for "${server}"`);
        }
        seen.add(page.nextCursor);
        next = page.nextCursor;
      }
      throw new McpTransportError("protocol", `Pagination limit (1000 pages) exceeded on resources/templates/list for "${server}"`);
    } catch (err) {
      if (err instanceof McpRpcError && err.code === ErrorCode.MethodNotFound) {
        return { resourceTemplates: [] };
      }
      throw err;
    }
  }

  async function read(
    server: string,
    uri: string,
    opts?: LogOpts,
  ): Promise<{ contents: JsonObject[]; blocks: Array<TextContent | ImageContent> }> {
    const client = requireClient(server);
    try {
      const result = await client.request<JsonObject>("resources/read", { uri }, toReqOpts(opts));
      if (!Array.isArray(result.contents)) {
        throw new McpTransportError(
          "protocol",
          `MCP server "${server}" returned invalid resources/read response for "${uri}"`,
        );
      }
      const contents = result.contents.filter(isRecord);
      const blocks = convertResourceContentsToBlocks(server, contents);
      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "" });
      }
      return { contents, blocks };
    } catch (err) {
      if (err instanceof McpRpcError && (err.code === -32602 || err.code === -32002)) {
        throw new Error(`Resource not found on MCP server "${server}": ${uri} (${err.message})`);
      }
      throw err;
    }
  }

  async function directory(
    server: string,
    uri: string,
    cursor?: string,
    opts?: LogOpts,
  ): Promise<{ resources: McpResourceItem[]; nextCursor?: string }> {
    const client = requireClient(server);
    if (!client.state.skillsDirectoryRead) {
      throw new Error(
        `MCP server "${server}" does not advertise directoryRead: true for resources/directory/read.`,
      );
    }
    const cleanUri = uri.length > 1 && uri.endsWith("/") ? uri.slice(0, -1) : uri;
    const res = await client.request<JsonObject>(
      "resources/directory/read",
      { uri: cleanUri, ...(cursor ? { cursor } : {}) },
      toReqOpts(opts),
    );
    const rawList = Array.isArray(res.resources) ? res.resources : [];
    return {
      resources: rawList
        .filter(isRecord)
        .map((r) => stripResourceIcons(r) as unknown as McpResourceItem),
      ...(typeof res.nextCursor === "string" ? { nextCursor: res.nextCursor } : {}),
    };
  }

  function buildRecord(rec: { server: string; uri: string; holdSettle: boolean }): ResourceSubscriptionRecord {
    const conn = connections.get(rec.server);
    const client = host.getClient(rec.server);
    const active = Boolean(!shutDown && client);
    const honored = Boolean(conn?.honoredUris.has(rec.uri));
    return {
      server: rec.server,
      uri: rec.uri,
      holdSettle: rec.holdSettle,
      active,
      honored,
    };
  }

  function subscribe(server: string, uri: string, holdSettle = false): ResourceSubscriptionRecord {
    const k = subKey(server, uri);
    const rec = { server, uri, holdSettle };
    watched.set(k, rec);
    const entry: ResourceSubEntry = { op: "upsert", server, uri, holdSettle };
    host.appendEntry(CUSTOM_RESOURCE_SUBSCRIPTIONS, entry);
    attachServer(server);
    emitState();
    return buildRecord(rec);
  }

  function unsubscribe(server: string, uri: string): boolean {
    const k = subKey(server, uri);
    if (!watched.delete(k)) return false;
    const entry: ResourceSubEntry = { op: "remove", server, uri };
    host.appendEntry(CUSTOM_RESOURCE_SUBSCRIPTIONS, entry);
    syncServerInterest(server);
    emitState();
    return true;
  }

  function restore(branch: readonly unknown[]): void {
    const next = new Map<string, { server: string; uri: string; holdSettle: boolean }>();
    for (const raw of branch) {
      if (!isRecord(raw) || raw.customType !== CUSTOM_RESOURCE_SUBSCRIPTIONS || !isRecord(raw.data)) {
        continue;
      }
      const data = raw.data as unknown as ResourceSubEntry;
      if (data.op === "upsert" && typeof data.server === "string" && typeof data.uri === "string") {
        next.set(subKey(data.server, data.uri), {
          server: data.server,
          uri: data.uri,
          holdSettle: data.holdSettle === true,
        });
      } else if (data.op === "remove" && typeof data.server === "string" && typeof data.uri === "string") {
        next.delete(subKey(data.server, data.uri));
      }
    }
    const affectedServers = new Set<string>([
      ...[...watched.values()].map((r) => r.server),
      ...[...next.values()].map((r) => r.server),
    ]);
    watched.clear();
    for (const [k, v] of next) watched.set(k, v);
    for (const server of affectedServers) {
      if (host.getClient(server)) attachServer(server);
      else syncServerInterest(server);
    }
    emitState();
  }

  function serverRemoved(server: string): void {
    const conn = connections.get(server);
    if (conn) {
      for (const off of conn.off) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      connections.delete(server);
    }
    pendingUpdates.delete(server);
    emitState();
  }

  async function shutdown(): Promise<void> {
    if (shutDown) return;
    shutDown = true;
    host.signal?.removeEventListener?.("abort", onAbort);
    flushBatch();
    for (const conn of connections.values()) {
      for (const off of conn.off) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      conn.client.setListenInterest("resources", {});
    }
    connections.clear();
    emitState();
  }

  return {
    restore,
    serverReady: attachServer,
    serverRemoved,
    flushPending: flushBatch,
    list,
    templates,
    read,
    directory,
    subscribe,
    unsubscribe,
    subscriptions: (server?: string) =>
      [...watched.values()]
        .filter((r) => !server || r.server === server)
        .map(buildRecord),
    holdsSettle: () =>
      !shutDown &&
      [...watched.values()].some(
        (r) =>
          r.holdSettle &&
          Boolean(host.getClient(r.server)) &&
          Boolean(connections.get(r.server)?.honoredUris.has(r.uri)),
      ),
    activeWatches: () =>
      shutDown ? 0 : [...watched.values()].filter((r) => Boolean(host.getClient(r.server))).length,
    onWake: (listener: () => void) => {
      wakeListeners.add(listener);
      return () => {
        wakeListeners.delete(listener);
      };
    },
    onStateChange: (listener: () => void) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    shutdown,
  };
}
