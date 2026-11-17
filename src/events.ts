/**
 * SEP-3415 events engine (spec §5.1, §5.3, §5.4): events/list discovery, poll and push
 * delivery, cursor persistence, per-subscription dedup, and batched turn wakes.
 * Depends only on EngineHost/ServerClient from types.ts.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { writePrivateTempFile } from "./temp-files.ts";
import {
  CUSTOM_CURSORS,
  CUSTOM_SUBSCRIPTIONS,
  ErrorCode,
  MESSAGE_EVENT,
  McpTransportError,
} from "./types.ts";
import type {
  CursorEntry,
  DeliveryMode,
  EngineHost,
  EventDelivery,
  EventDescriptor,
  EventOccurrence,
  EventsEngineApi,
  JSONRPCNotification,
  JsonObject,
  ListEventsResult,
  McpLogLevel,
  McpLogMessage,
  OpenStreamHandle,
  PollEventsParams,
  PollEventsResult,
  ServerClient,
  SubscribeRequest,
  SubscriptionEntry,
  SubscriptionRecord,
} from "./types.ts";

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported)
// ---------------------------------------------------------------------------------------------

/** JSON with object keys sorted recursively, so equal argument objects map to one string. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(item => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, value]) => `${JSON.stringify(k)}:${canonicalJson(value)}`).join(",")}}`;
}

export function subKeyOf(server: string, name: string, args?: Record<string, unknown>): string {
  return `${server}\0${name}\0${canonicalJson(args ?? {})}`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeXmlCloseTags(value: string): string {
  return value.replace(/<\/(mcp_[a-zA-Z0-9_]*)/gi, "<\\/$1");
}

/**
 * Frame deliveries as untrusted external data: one `<mcp_event ...>` tag per occurrence with a
 * JSON body (head-truncated; the full payload goes to a temp file when truncated), preceded by a
 * gap marker for truncated deliveries.
 */
export function formatEventDeliveries(batch: EventDelivery[]): string {
  const parts: string[] = [];
  for (const delivery of batch) {
    if (delivery.truncated) {
      parts.push(
        `<mcp_event_gap server="${escapeAttr(delivery.server)}" name="${escapeAttr(delivery.name)}" truncated="true">` +
          `gap: events before this point may have been missed (truncated)</mcp_event_gap>`,
      );
    }
    for (const occ of delivery.occurrences) {
      const full = JSON.stringify(occ.data ?? {}, null, 2);
      const truncated = truncateHead(full, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      let body = escapeXmlCloseTags(truncated.content);
      if (truncated.truncated) {
        try {
          const file = writePrivateTempFile("mcp-event", "json", full);
          body += `\n[truncated: full payload written to ${file}]`;
        } catch {
          body += `\n[truncated]`;
        }
      }
      parts.push(
        `<mcp_event server="${escapeAttr(delivery.server)}" name="${escapeAttr(occ.name ?? delivery.name)}" ` +
          `event_id="${escapeAttr(occ.eventId)}" timestamp="${escapeAttr(occ.timestamp)}" truncated="${delivery.truncated ? "true" : "false"}">\n` +
          `${body}\n</mcp_event>`,
      );
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

interface Sub {
  record: SubscriptionRecord;
  cursor: string | null;
  mode?: "push" | "poll";
  descriptorDelivery: DeliveryMode[];
  recentIds: string[];
  recentSet: Set<string>;
  started: boolean;
  stopped: boolean;
  startPromise?: Promise<void>;
  generation: number;
  stream?: OpenStreamHandle;
  streamGen: number;
  effectiveWatchdogMs: number;
  watchdogTimer?: ReturnType<typeof setTimeout>;
  pollTimer?: ReturnType<typeof setTimeout>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  checkpointTimer?: ReturnType<typeof setTimeout>;
  backoffMs: number;
  dirtyCursor: boolean;
  lastFlushAt: number;
}

function errorCodeOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}
function errorDataOf(err: unknown): Record<string, unknown> | undefined {
  const data = (err as { data?: unknown } | null)?.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}
function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, Math.max(0, ms));
  (t as { unref?: () => void }).unref?.();
  return t;
}

export function createEventsEngine(
  host: EngineHost,
  opts?: { pollFloorMs?: number; batchWindowMs?: number; watchdogMs?: number; checkpointMs?: number },
): EventsEngineApi {
  const pollFloorMs = opts?.pollFloorMs ?? 1000;
  const batchWindowMs = opts?.batchWindowMs ?? 75;
  const watchdogMs = opts?.watchdogMs ?? 90000;
  const checkpointMs = opts?.checkpointMs ?? 30000;

  const subs = new Map<string, Sub>();
  const descriptorCache = new Map<string, EventDescriptor[]>();
  const inflightLists = new Map<string, Promise<EventDescriptor[]>>();
  /** Newest non-null cursor per subKey, from restored entries. */
  const persistedCursors = new Map<string, string>();
  /** Newest recentEventIds per subKey, from restored entries. */
  const persistedRecent = new Map<string, string[]>();
  const listenDisposers = new Map<string, { client: ServerClient; dispose: () => void }>();
  const wakeListeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  const pendingBatch = new Map<string, EventDelivery>();
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let shutDown = false;

  const onAbort = () => void shutdown();
  host.signal?.addEventListener?.("abort", onAbort, { once: true });

  function emitStateChange(): void {
    for (const listener of [...stateListeners]) {
      try { listener(); } catch { /* listener faults are not engine faults */ }
    }
  }

  // ---- wakes / batching -------------------------------------------------------

  function emitWake(content: string, details: unknown): void {
    host.wake(MESSAGE_EVENT, content, details);
    for (const listener of [...wakeListeners]) {
      try { listener(); } catch { /* listener faults are not delivery faults */ }
    }
  }

  function flushBatch(): void {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
    if (!pendingBatch.size) return;
    const batch = [...pendingBatch.values()];
    pendingBatch.clear();
    emitWake(formatEventDeliveries(batch), { deliveries: batch });
    for (const delivery of batch) {
      const sub = subs.get(delivery.subKey);
      if (sub && sub.dirtyCursor) {
        persistCursor(sub);
      }
    }
  }

  function enqueueDelivery(sub: Sub, occurrences: EventOccurrence[], truncated: boolean): void {
    const key = sub.record.subKey;
    sub.dirtyCursor = true;
    const existing = pendingBatch.get(key);
    if (existing) {
      existing.occurrences.push(...occurrences);
      existing.truncated = existing.truncated || truncated;
    } else {
      pendingBatch.set(key, {
        server: sub.record.server,
        subKey: key,
        name: sub.record.name,
        truncated,
        occurrences: [...occurrences],
      });
    }
    batchTimer ??= timer(flushBatch, batchWindowMs);
  }

  function wakeNotice(sub: Sub, message: string): void {
    emitWake(
      `<mcp_event_notice server="${escapeAttr(sub.record.server)}" name="${escapeAttr(sub.record.name)}">${escapeAttr(message)}</mcp_event_notice>`,
      { deliveries: [], notice: message, server: sub.record.server, name: sub.record.name, subKey: sub.record.subKey },
    );
  }

  // ---- cursor persistence -----------------------------------------------------

  function persistCursor(sub: Sub): void {
    const entry: CursorEntry = {
      server: sub.record.server,
      subKey: sub.record.subKey,
      cursor: sub.cursor,
      recentEventIds: sub.recentIds.slice(-128),
      updatedAt: new Date().toISOString(),
    };
    host.appendEntry(CUSTOM_CURSORS, entry);
    sub.dirtyCursor = false;
    sub.lastFlushAt = Date.now();
    if (sub.checkpointTimer) { clearTimeout(sub.checkpointTimer); sub.checkpointTimer = undefined; }
  }

  /** Quiet-period advance: update memory now, flush at most once per checkpointMs. */
  function markCursorQuiet(sub: Sub): void {
    sub.dirtyCursor = true;
    const elapsed = Date.now() - sub.lastFlushAt;
    if (sub.lastFlushAt !== 0 && elapsed >= checkpointMs) { persistCursor(sub); return; }
    if (!sub.checkpointTimer) {
      const wait = sub.lastFlushAt === 0 ? 0 : checkpointMs - elapsed;
      sub.checkpointTimer = timer(() => {
        sub.checkpointTimer = undefined;
        if (sub.dirtyCursor && !shutDown) persistCursor(sub);
      }, wait);
    }
  }

  function setCursor(sub: Sub, cursor: string | null | undefined): boolean {
    const next = typeof cursor === "string" ? cursor : null;
    const changed = next !== sub.cursor;
    sub.cursor = next;
    return changed;
  }

  // ---- dedup / occurrence intake ----------------------------------------------

  /** Filter duplicates (FIFO of 1024 per subKey) and advance the cursor per occurrence. */
  function acceptOccurrences(sub: Sub, occurrences: EventOccurrence[], advancePerEvent: boolean): EventOccurrence[] {
    const accepted: EventOccurrence[] = [];
    for (const occ of occurrences) {
      if (advancePerEvent) setCursor(sub, occ.cursor);
      if (occ.eventId != null && sub.recentSet.has(occ.eventId)) continue;
      if (occ.eventId != null) {
        sub.recentSet.add(occ.eventId);
        sub.recentIds.push(occ.eventId);
        while (sub.recentIds.length > 1024) {
          const evicted = sub.recentIds.shift();
          if (evicted !== undefined) sub.recentSet.delete(evicted);
        }
      }
      accepted.push(occ);
    }
    return accepted;
  }

  // ---- events/list --------------------------------------------------------------

  function ensureListen(server: string, client: ServerClient): void {
    const existing = listenDisposers.get(server);
    if (existing?.client === client) return;
    existing?.dispose();
    listenDisposers.delete(server);
    if (!client.state?.eventsListChanged) return;
    client.setListenInterest("events", { eventsListChanged: true });
    const dispose = client.onListenNotification((msg: JSONRPCNotification) => {
      if (msg.method === "notifications/events/list_changed") {
        descriptorCache.delete(server);
        void list(server).catch(err => host.log("warn", `events/list refresh for ${server} failed: ${errorMessageOf(err)}`));
      }
    });
    listenDisposers.set(server, { client, dispose });
  }

  async function fetchList(
    server: string,
    client: ServerClient,
    opts?: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void },
  ): Promise<EventDescriptor[]> {
    const events: EventDescriptor[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    const reqOpts = opts?.logLevel || opts?.onLog
      ? { ...(opts.logLevel ? { logLevel: opts.logLevel } : {}), ...(opts.onLog ? { onLog: opts.onLog } : {}) }
      : undefined;
    for (let page = 0; page < 1_000; page++) {
      const result = await client.request<ListEventsResult>(
        "events/list",
        cursor ? { cursor } : {},
        reqOpts,
      );
      events.push(...(result.events ?? []));
      const next = result.nextCursor;
      if (!next) {
        descriptorCache.set(server, events);
        return events;
      }
      if (seenCursors.has(next)) {
        throw new McpTransportError("protocol", `Duplicate pagination cursor on events/list for "${server}"`);
      }
      seenCursors.add(next);
      cursor = next;
    }
    throw new McpTransportError("protocol", `Pagination limit (1000 pages) exceeded on events/list for "${server}"`);
  }

  async function list(
    server: string,
    opts?: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void },
  ): Promise<EventDescriptor[]> {
    const client = host.getClient(server);
    if (!client) throw new Error(`Unknown or not-ready MCP server: ${server}`);
    ensureListen(server, client);
    if (opts?.logLevel || opts?.onLog) {
      return fetchList(server, client, opts);
    }
    const existing = inflightLists.get(server);
    if (existing) return existing;
    const pending = fetchList(server, client).finally(() => {
      if (inflightLists.get(server) === pending) inflightLists.delete(server);
    });
    inflightLists.set(server, pending);
    return pending;
  }

  function selectMode(sub: Sub, descriptor: EventDescriptor): "push" | "poll" {
    const available = (descriptor.delivery ?? []).filter(m => m === "push" || m === "poll");
    if (!available.length) {
      throw new Error(
        `UnsupportedDeliveryMode: event "${descriptor.name}" on server "${sub.record.server}" only supports ` +
          `${JSON.stringify(descriptor.delivery ?? [])}; this client supports "push" and "poll" (webhook is not supported)`,
      );
    }
    if (sub.record.delivery === "poll" && available.includes("poll")) return "poll";
    return available.includes("push") ? "push" : "poll";
  }

  // ---- poll ---------------------------------------------------------------------

  function pollParams(sub: Sub): JsonObject {
    const params: JsonObject = { name: sub.record.name, cursor: sub.cursor, maxEvents: 100 };
    if (sub.record.arguments !== undefined) params.arguments = sub.record.arguments;
    if (sub.record.maxAgeMs !== undefined) params.maxAgeMs = sub.record.maxAgeMs;
    return params;
  }

  function schedulePoll(sub: Sub, delayMs: number): void {
    if (shutDown || sub.stopped) return;
    if (sub.pollTimer) clearTimeout(sub.pollTimer);
    const gen = sub.generation;
    sub.pollTimer = timer(() => {
      sub.pollTimer = undefined;
      void pollCycle(sub, gen).catch(err => host.log("warn", `events/poll loop for ${sub.record.name} failed: ${errorMessageOf(err)}`));
    }, delayMs);
  }

  function livePoll(sub: Sub, gen: number): boolean {
    return !shutDown && !sub.stopped && sub.generation === gen && subs.get(sub.record.subKey) === sub && sub.mode === "poll";
  }

  /** One drain cycle; returns the last result (used by the push catch-up handoff). */
  async function drainPoll(sub: Sub, client: ServerClient, gen: number): Promise<PollEventsResult | undefined> {
    let last: PollEventsResult | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await client.request<PollEventsResult>("events/poll", pollParams(sub));
      last = result;
      const accepted = acceptOccurrences(sub, result.events ?? [], true);
      const cursorChanged = setCursor(sub, result.cursor);
      const truncated = result.truncated === true;
      if (accepted.length || truncated) {
        enqueueDelivery(sub, accepted, truncated);
      } else if (cursorChanged) {
        markCursorQuiet(sub);
      }
      if (!result.hasMore) {
        flushBatch();
        return result;
      }
      if (shutDown || sub.stopped || sub.generation !== gen) {
        flushBatch();
        return result;
      }
    }
    flushBatch();
    return last; // 50 pages drained; caller yields before continuing
  }

  async function pollCycle(sub: Sub, gen: number): Promise<void> {
    if (!livePoll(sub, gen)) return;
    const client = host.getClient(sub.record.server);
    if (!client) { schedulePoll(sub, Math.max(5000, pollFloorMs)); return; }
    try {
      const last = await drainPoll(sub, client, gen);
      if (!livePoll(sub, gen)) return;
      sub.backoffMs = 250;
      if (last?.hasMore) schedulePoll(sub, 0);
      else schedulePoll(sub, Math.max(last?.nextPollMs ?? 5000, pollFloorMs));
    } catch (err) {
      if (!livePoll(sub, gen)) return;
      if (handleTerminalRpcError(sub, err)) return;
      host.log("warn", `events/poll for ${sub.record.server}/${sub.record.name} failed: ${errorMessageOf(err)}`);
      sub.backoffMs = Math.min(sub.backoffMs ? sub.backoffMs * 2 : 250, 30000);
      schedulePoll(sub, Math.max(sub.backoffMs, pollFloorMs));
    }
  }

  // ---- push ---------------------------------------------------------------------

  function clearWatchdog(sub: Sub): void {
    if (sub.watchdogTimer) { clearTimeout(sub.watchdogTimer); sub.watchdogTimer = undefined; }
  }

  function armWatchdog(sub: Sub, streamGen: number): void {
    clearWatchdog(sub);
    sub.watchdogTimer = timer(() => {
      sub.watchdogTimer = undefined;
      if (shutDown || sub.stopped || sub.streamGen !== streamGen) return;
      const handle = sub.stream;
      sub.stream = undefined;
      sub.streamGen++; // invalidate the cancelled stream's done handler
      host.log("warn", `events/stream watchdog expired for ${sub.record.server}/${sub.record.name}; reconnecting`);
      void (async () => {
        try { await handle?.cancel("watchdog"); } catch { /* already gone */ }
        if (!shutDown && !sub.stopped && subs.get(sub.record.subKey) === sub) {
          await openPush(sub).catch(err => host.log("warn", `events/stream reconnect failed: ${errorMessageOf(err)}`));
        }
      })();
    }, sub.effectiveWatchdogMs);
  }

  function scheduleReconnect(sub: Sub): void {
    if (shutDown || sub.stopped || sub.reconnectTimer) return;
    sub.backoffMs = Math.min(sub.backoffMs ? sub.backoffMs * 2 : 250, 30000);
    const gen = sub.generation;
    sub.reconnectTimer = timer(() => {
      sub.reconnectTimer = undefined;
      if (shutDown || sub.stopped || sub.generation !== gen) return;
      void openPush(sub).catch(err => host.log("warn", `events/stream reconnect failed: ${errorMessageOf(err)}`));
    }, sub.backoffMs);
  }

  /** Terminal RPC failures shared by poll and push. Returns true when handled as a stop. */
  function handleTerminalRpcError(sub: Sub, err: unknown): boolean {
    const code = errorCodeOf(err);
    if (code === ErrorCode.Forbidden) { terminateSub(sub, code, errorMessageOf(err)); return true; }
    if (code === ErrorCode.NotFound) { terminateSub(sub, code, errorMessageOf(err)); return true; }
    if (code === ErrorCode.Unsupported && errorDataOf(err)?.reason === "schema_changed") {
      terminateSub(sub, code, errorMessageOf(err));
      return true;
    }
    return false;
  }

  function terminateSub(sub: Sub, code: number, message: string): void {
    sub.stopped = true;
    sub.started = false;
    sub.streamGen++;
    clearWatchdog(sub);
    if (sub.pollTimer) { clearTimeout(sub.pollTimer); sub.pollTimer = undefined; }
    if (sub.reconnectTimer) { clearTimeout(sub.reconnectTimer); sub.reconnectTimer = undefined; }
    const handle = sub.stream;
    sub.stream = undefined;
    if (handle) void handle.cancel("terminated").catch(() => {});
    persistCursor(sub); // termination flush
    const removeEntry: SubscriptionEntry = { op: "remove", subKey: sub.record.subKey, server: sub.record.server };
    host.appendEntry(CUSTOM_SUBSCRIPTIONS, removeEntry);
    if (code === ErrorCode.NotFound || code === ErrorCode.Unsupported) {
      descriptorCache.delete(sub.record.server);
      void list(sub.record.server).catch(e => host.log("warn", `events/list refresh failed: ${errorMessageOf(e)}`));
      wakeNotice(sub, `event subscription ended: the event descriptor changed or was removed (${code}: ${message})`);
    } else if (code === ErrorCode.Forbidden) {
      wakeNotice(sub, `event subscription terminated: access was revoked (${code}: ${message}); not reconnecting`);
    } else {
      wakeNotice(sub, `event subscription terminated (${code}: ${message})`);
    }
    emitStateChange();
  }

  function fallbackToPoll(sub: Sub, reason: string): void {
    if (!sub.descriptorDelivery.includes("poll")) {
      host.log("warn", `events/stream unsupported for ${sub.record.server}/${sub.record.name} and poll is not available: ${reason}`);
      scheduleReconnect(sub);
      return;
    }
    host.log("info", `events/stream unsupported for ${sub.record.server}/${sub.record.name}; falling back to poll`);
    sub.mode = "poll";
    sub.streamGen++;
    clearWatchdog(sub);
    sub.stream = undefined;
    emitStateChange();
    void pollCycle(sub, sub.generation).catch(err => host.log("warn", `events/poll fallback failed: ${errorMessageOf(err)}`));
  }

  function handleStreamNotification(sub: Sub, streamGen: number, msg: JSONRPCNotification): void {
    if (shutDown || sub.stopped || sub.streamGen !== streamGen) return;
    armWatchdog(sub, streamGen); // any stream notification (incl. $/sse-comment) proves liveness
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case "notifications/events/active": {
        if (typeof params.heartbeatMs === "number" && Number.isFinite(params.heartbeatMs) && params.heartbeatMs > 0) {
          sub.effectiveWatchdogMs = Math.max(10, Math.round(params.heartbeatMs * 3));
          armWatchdog(sub, streamGen);
        }
        const changed = setCursor(sub, params.cursor as string | null | undefined);
        const truncated = params.truncated === true;
        if (truncated) {
          enqueueDelivery(sub, [], true);
        } else if (changed) {
          persistCursor(sub); // activation persists the fresh cursor
        }
        break;
      }
      case "notifications/events/event": {
        const occ = params as unknown as EventOccurrence;
        const before = sub.cursor;
        const accepted = acceptOccurrences(sub, [occ], true);
        if (accepted.length) {
          enqueueDelivery(sub, accepted, false);
        } else if (sub.cursor !== before) {
          markCursorQuiet(sub);
        }
        break;
      }
      case "notifications/events/heartbeat": {
        if (setCursor(sub, params.cursor as string | null | undefined)) markCursorQuiet(sub);
        break;
      }
      case "notifications/events/error": {
        const error = params.error as { code?: number; message?: string } | undefined;
        host.log("warn", `events/stream error for ${sub.record.server}/${sub.record.name}: ${error?.message ?? "unknown"} (${error?.code ?? "?"})`);
        break; // keep the stream open
      }
      case "notifications/events/terminated": {
        const error = (params.error ?? {}) as { code?: number; message?: string; data?: Record<string, unknown> };
        const code = typeof error.code === "number" ? error.code : ErrorCode.InternalError;
        const message = error.message ?? "terminated";
        if (code === ErrorCode.Unsupported && error.data?.reason !== "schema_changed" && sub.descriptorDelivery.includes("poll")) {
          persistCursor(sub);
          fallbackToPoll(sub, message);
        } else {
          terminateSub(sub, code, message);
        }
        break;
      }
      default:
        break; // e.g. $/sse-comment: watchdog already reset
    }
  }

  async function openPush(sub: Sub): Promise<void> {
    if (shutDown || sub.stopped) return;
    const client = host.getClient(sub.record.server);
    if (!client) { sub.started = false; return; }
    const gen = sub.generation;

    // Catch-up handoff: with both modes and a stored cursor, drain via poll before streaming.
    if (sub.descriptorDelivery.includes("poll") && sub.descriptorDelivery.includes("push") && sub.cursor !== null) {
      try {
        let last = await drainPoll(sub, client, gen);
        while (last?.hasMore && !shutDown && !sub.stopped && sub.generation === gen) {
          last = await drainPoll(sub, client, gen);
        }
      } catch (err) {
        if (handleTerminalRpcError(sub, err)) return;
        host.log("warn", `events/poll catch-up for ${sub.record.server}/${sub.record.name} failed: ${errorMessageOf(err)}`);
        scheduleReconnect(sub);
        return;
      }
      if (shutDown || sub.stopped || sub.generation !== gen) return;
    }

    const streamGen = ++sub.streamGen;
    const params: JsonObject = { name: sub.record.name, cursor: sub.cursor };
    if (sub.record.arguments !== undefined) params.arguments = sub.record.arguments;
    if (sub.record.maxAgeMs !== undefined) params.maxAgeMs = sub.record.maxAgeMs;

    let handle: OpenStreamHandle;
    try {
      handle = await client.openStream("events/stream", params, msg => handleStreamNotification(sub, streamGen, msg));
    } catch (err) {
      if (shutDown || sub.stopped || sub.generation !== gen) return;
      if (errorCodeOf(err) === ErrorCode.Unsupported && errorDataOf(err)?.reason !== "schema_changed") {
        fallbackToPoll(sub, errorMessageOf(err));
        return;
      }
      if (handleTerminalRpcError(sub, err)) return;
      host.log("warn", `events/stream open failed for ${sub.record.server}/${sub.record.name}: ${errorMessageOf(err)}`);
      scheduleReconnect(sub);
      return;
    }
    if (shutDown || sub.stopped || sub.generation !== gen || sub.streamGen !== streamGen) {
      void handle.cancel("superseded").catch(() => {});
      return;
    }
    sub.stream = handle;
    sub.effectiveWatchdogMs = watchdogMs;
    sub.backoffMs = 250;
    emitStateChange();
    armWatchdog(sub, streamGen);
    void handle.done.then(
      () => {
        if (sub.streamGen !== streamGen || sub.stopped || shutDown) return;
        sub.stream = undefined;
        emitStateChange();
        clearWatchdog(sub);
        persistCursor(sub); // stream close flush
        scheduleReconnect(sub); // ended without terminated: reconnect with backoff
      },
      (err: unknown) => {
        if (sub.streamGen !== streamGen || sub.stopped || shutDown) return;
        sub.stream = undefined;
        emitStateChange();
        clearWatchdog(sub);
        if (errorCodeOf(err) === ErrorCode.Unsupported && errorDataOf(err)?.reason !== "schema_changed") {
          fallbackToPoll(sub, errorMessageOf(err));
          return;
        }
        if (handleTerminalRpcError(sub, err)) return;
        host.log("warn", `events/stream for ${sub.record.server}/${sub.record.name} failed: ${errorMessageOf(err)}`);
        persistCursor(sub);
        scheduleReconnect(sub);
      },
    );
  }

  // ---- subscription lifecycle ---------------------------------------------------

  function newSub(record: SubscriptionRecord, cursor: string | null): Sub {
    const recentIds = (persistedRecent.get(record.subKey) ?? []).slice(-1024);
    return {
      record,
      cursor,
      descriptorDelivery: [],
      recentIds,
      recentSet: new Set(recentIds),
      started: false,
      stopped: false,
      generation: 0,
      streamGen: 0,
      effectiveWatchdogMs: watchdogMs,
      backoffMs: 250,
      dirtyCursor: false,
      lastFlushAt: 0,
    };
  }

  function isActive(sub: Sub): boolean {
    return sub.started && !sub.stopped && !shutDown;
  }

  async function startSub(sub: Sub): Promise<void> {
    if (shutDown || sub.stopped || sub.started) return sub.startPromise ?? Promise.resolve();
    if (sub.startPromise) return sub.startPromise;
    const client = host.getClient(sub.record.server);
    if (!client) return; // recorded; serverReady starts it later
    sub.startPromise = (async () => {
      try {
        ensureListen(sub.record.server, client);
        const descriptors = descriptorCache.get(sub.record.server) ?? (await list(sub.record.server));
        const descriptor = descriptors.find(d => d.name === sub.record.name);
        if (!descriptor) {
          host.log("warn", `event "${sub.record.name}" not found in events/list for ${sub.record.server}; subscription not started`);
          return;
        }
        sub.descriptorDelivery = descriptor.delivery ?? [];
        sub.mode = selectMode(sub, descriptor); // throws UnsupportedDeliveryMode for webhook-only
        sub.started = true;
        emitStateChange();
        if (sub.mode === "poll") await pollCycle(sub, sub.generation);
        else await openPush(sub);
      } finally {
        sub.startPromise = undefined;
      }
    })();
    return sub.startPromise;
  }

  async function stopSub(sub: Sub): Promise<void> {
    sub.stopped = true;
    sub.started = false;
    sub.generation++;
    sub.streamGen++;
    clearWatchdog(sub);
    if (sub.pollTimer) { clearTimeout(sub.pollTimer); sub.pollTimer = undefined; }
    if (sub.reconnectTimer) { clearTimeout(sub.reconnectTimer); sub.reconnectTimer = undefined; }
    if (sub.checkpointTimer) { clearTimeout(sub.checkpointTimer); sub.checkpointTimer = undefined; }
    if (sub.dirtyCursor) persistCursor(sub);
    const handle = sub.stream;
    sub.stream = undefined;
    emitStateChange();
    if (handle) { try { await handle.cancel("stopped"); } catch { /* already gone */ } }
  }

  // ---- public API -----------------------------------------------------------------

  function restore(branch: readonly unknown[], allEntries: readonly unknown[]): void {
    const asCustom = (e: unknown): { customType?: string; data?: unknown } | undefined =>
      typeof e === "object" && e !== null ? (e as { customType?: string; data?: unknown }) : undefined;

    // Newest non-null cursor + newest recentEventIds per subKey across all entries.
    for (const raw of allEntries) {
      const entry = asCustom(raw);
      if (!entry) continue;
      if (entry.customType === CUSTOM_CURSORS) {
        const data = entry.data as CursorEntry | undefined;
        if (!data?.subKey) continue;
        if (typeof data.cursor === "string") persistedCursors.set(data.subKey, data.cursor);
        if (Array.isArray(data.recentEventIds)) persistedRecent.set(data.subKey, [...data.recentEventIds]);
      } else if (entry.customType === CUSTOM_SUBSCRIPTIONS) {
        const data = entry.data as SubscriptionEntry | undefined;
        if (data?.op === "upsert" && typeof data.cursor === "string") {
          persistedCursors.set(data.subscription.subKey, data.cursor);
        }
      }
    }

    // Active subscription set from the branch.
    const active = new Map<string, SubscriptionRecord>();
    for (const raw of branch) {
      const entry = asCustom(raw);
      if (entry?.customType !== CUSTOM_SUBSCRIPTIONS) continue;
      const data = entry.data as SubscriptionEntry | undefined;
      if (data?.op === "upsert") active.set(data.subscription.subKey, data.subscription);
      else if (data?.op === "remove") active.delete(data.subKey);
    }

    for (const sub of [...subs.values()]) {
      if (!active.has(sub.record.subKey)) {
        subs.delete(sub.record.subKey);
        void stopSub(sub);
      }
    }
    for (const record of active.values()) {
      if (!subs.has(record.subKey)) {
        subs.set(record.subKey, newSub(record, persistedCursors.get(record.subKey) ?? null));
      }
    }
    for (const sub of subs.values()) {
      void startSub(sub).catch(err => host.log("warn", `starting subscription ${sub.record.name} failed: ${errorMessageOf(err)}`));
    }
  }

  function serverRemoved(server: string): void {
    const ld = listenDisposers.get(server);
    if (ld) {
      ld.dispose();
      listenDisposers.delete(server);
    }
    descriptorCache.delete(server);
    inflightLists.delete(server);
    for (const sub of subs.values()) {
      if (sub.record.server === server && !sub.stopped) {
        sub.started = false;
        sub.streamGen++;
        clearWatchdog(sub);
        if (sub.pollTimer) { clearTimeout(sub.pollTimer); sub.pollTimer = undefined; }
        if (sub.reconnectTimer) { clearTimeout(sub.reconnectTimer); sub.reconnectTimer = undefined; }
        const handle = sub.stream;
        sub.stream = undefined;
        if (handle) void handle.cancel("server removed").catch(() => {});
      }
    }
    emitStateChange();
  }
  function serverReady(server: string): void {
    const client = host.getClient(server);
    if (client) ensureListen(server, client);
    for (const sub of subs.values()) {
      if (sub.record.server === server && !sub.stopped) {
        void startSub(sub).catch(err => host.log("warn", `starting subscription ${sub.record.name} failed: ${errorMessageOf(err)}`));
      }
    }
  }

  async function subscribe(req: SubscribeRequest): Promise<SubscriptionRecord> {
    const args = req.arguments as Record<string, unknown> | undefined;
    const subKey = subKeyOf(req.server, req.name, args);
    const existing = subs.get(subKey);
    // Idempotent: an already-active subscription is not reopened (declarative subscriptions rely on this).
    if (existing && isActive(existing) && req.cursor === undefined) return existing.record;
    if (existing && existing.startPromise && req.cursor === undefined) {
      await existing.startPromise.catch(() => {});
      if (isActive(existing)) return existing.record;
    }

    const client = host.getClient(req.server);
    if (client) {
      // Validate against cached descriptor when present, otherwise refresh events/list.
      let descriptor = descriptorCache.get(req.server)?.find(d => d.name === req.name);
      if (!descriptor) {
        const descriptors = await list(req.server);
        descriptor = descriptors.find(d => d.name === req.name);
      }
      if (!descriptor) throw new Error(`Unknown event "${req.name}" on server "${req.server}" (not in events/list)`);
      const probe: Sub = existing ?? newSub(
        { subKey, server: req.server, name: req.name, delivery: req.delivery ?? "auto", holdSettle: false },
        null,
      );
      const wanted: SubscriptionRecord = {
        subKey,
        server: req.server,
        name: req.name,
        ...(req.arguments !== undefined ? { arguments: req.arguments } : {}),
        delivery: req.delivery ?? "auto",
        ...(req.maxAgeMs !== undefined ? { maxAgeMs: req.maxAgeMs } : {}),
        holdSettle: req.holdSettle ?? false,
      };
      probe.record = wanted;
      selectMode(probe, descriptor); // throws UnsupportedDeliveryMode for webhook-only
    }

    const record: SubscriptionRecord = {
      subKey,
      server: req.server,
      name: req.name,
      ...(req.arguments !== undefined ? { arguments: req.arguments } : {}),
      delivery: req.delivery ?? "auto",
      ...(req.maxAgeMs !== undefined ? { maxAgeMs: req.maxAgeMs } : {}),
      holdSettle: req.holdSettle ?? false,
    };
    const initialCursor = req.cursor !== undefined ? req.cursor : (persistedCursors.get(subKey) ?? existing?.cursor ?? null);

    let sub: Sub;
    if (existing) {
      await stopSub(existing);
      existing.stopped = false;
      existing.record = record;
      existing.cursor = initialCursor;
      sub = existing;
    } else {
      sub = newSub(record, initialCursor);
      subs.set(subKey, sub);
    }
    const entry: SubscriptionEntry = { op: "upsert", subscription: record, cursor: initialCursor };
    host.appendEntry(CUSTOM_SUBSCRIPTIONS, entry);
    await startSub(sub);
    return record;
  }

  async function unsubscribe(server: string, name: string, args?: JsonObject): Promise<boolean> {
    const subKey = subKeyOf(server, name, args as Record<string, unknown> | undefined);
    const sub = subs.get(subKey);
    if (!sub) return false;
    subs.delete(subKey);
    persistedCursors.delete(subKey);
    persistedRecent.delete(subKey);
    await stopSub(sub);
    const entry: SubscriptionEntry = { op: "remove", subKey, server };
    host.appendEntry(CUSTOM_SUBSCRIPTIONS, entry);
    emitStateChange();
    return true;
  }

  async function poll(
    server: string,
    params: PollEventsParams,
    opts?: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void },
  ): Promise<PollEventsResult> {
    const client = host.getClient(server);
    if (!client) throw new Error(`Unknown or not-ready MCP server: ${server}`);
    ensureListen(server, client);
    const wire: JsonObject = { name: params.name, cursor: params.cursor ?? null };
    if (params.arguments !== undefined) wire.arguments = params.arguments;
    if (params.maxAgeMs !== undefined) wire.maxAgeMs = params.maxAgeMs;
    if (params.maxEvents !== undefined) wire.maxEvents = params.maxEvents;
    const reqOpts = opts?.logLevel || opts?.onLog
      ? { ...(opts.logLevel ? { logLevel: opts.logLevel } : {}), ...(opts.onLog ? { onLog: opts.onLog } : {}) }
      : undefined;
    const result = await client.request<PollEventsResult>("events/poll", wire, reqOpts);
    return { ...result, cursor: result.cursor ?? null };
  }

  async function shutdown(): Promise<void> {
    if (shutDown) return;
    shutDown = true;
    host.signal?.removeEventListener?.("abort", onAbort);
    flushBatch();
    for (const ld of listenDisposers.values()) { try { ld.dispose(); } catch { /* ignore */ } }
    listenDisposers.clear();
    inflightLists.clear();
    await Promise.all([...subs.values()].map(sub => stopSub(sub))); // stopSub flushes dirty cursors
    emitStateChange();
  }

  return {
    restore,
    serverReady,
    serverRemoved,
    list,
    subscribe,
    unsubscribe,
    subscriptions: () =>
      [...subs.values()].map(sub => ({
        ...sub.record,
        cursor: sub.cursor,
        active: isActive(sub),
        ...(sub.mode ? { mode: sub.mode } : {}),
      })),
    poll,
    flushPending: flushBatch,
    holdsSettle: () => [...subs.values()].some(sub => sub.record.holdSettle && isActive(sub)),
    activeStreams: () => [...subs.values()].filter(sub => sub.stream !== undefined).length,
    onWake: (listener: () => void) => {
      wakeListeners.add(listener);
      return () => { wakeListeners.delete(listener); };
    },
    onStateChange: (listener: () => void) => {
      stateListeners.add(listener);
      return () => { stateListeners.delete(listener); };
    },
    shutdown,
  };
}
