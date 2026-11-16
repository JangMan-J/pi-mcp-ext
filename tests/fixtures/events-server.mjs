#!/usr/bin/env node
// Canonical MCP 2026-07-28 / SEP-3415 stdio fixture for the events integration suite.
// EVENTS_SERVER_MODE selects the wire script; EVENTS_SERVER_LOG receives a JSONL request journal.
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const PROTOCOL_VERSION = "2026-07-28";
const EVENTS = "io.modelcontextprotocol/events";
const META_PROTOCOL = "io.modelcontextprotocol/protocolVersion";
const META_SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";
const mode = process.env.EVENTS_SERVER_MODE ?? "catchup";
const logPath = process.env.EVENTS_SERVER_LOG;
const timers = new Map();
let streamCount = 0;

function journal(entry) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: { resultType: "complete", ...value } });
}

function notify(id, method, params = {}) {
  send({
    jsonrpc: "2.0",
    method,
    params: { ...params, _meta: { ...(params._meta ?? {}), [META_SUBSCRIPTION]: id } },
  });
}

function occurrence(eventId, cursor, name = "thing.happened") {
  return {
    eventId,
    name,
    timestamp: "2026-07-28T00:00:00.000Z",
    data: { eventId },
    cursor,
  };
}

function descriptors() {
  if (mode === "edge") {
    return [
      { name: "null.event", description: "Poll responses without cursors", delivery: ["poll"] },
      { name: "truncated.event", description: "A truncated push activation", delivery: ["push"] },
    ];
  }
  return [{ name: "thing.happened", description: "Scripted event", delivery: ["push", "poll"] }];
}

function poll(id, params) {
  const cursor = params.cursor ?? null;
  journal({ method: "events/poll", id, params });

  if (mode === "catchup" && params.name === "thing.happened") {
    if (cursor === "persisted-0") {
      result(id, {
        events: [occurrence("catchup-1", "persisted-1")],
        cursor: "persisted-1",
        hasMore: true,
        nextPollMs: 60_000,
      });
      return;
    }
    if (cursor === "persisted-1") {
      result(id, {
        events: [occurrence("catchup-2", "persisted-2")],
        cursor: "persisted-2",
        hasMore: false,
      });
      return;
    }
  }

  if (mode === "resume" && cursor === "resume-1") {
    result(id, {
      // The first occurrence was delivered before restore and must be deduplicated.
      events: [occurrence("resume-1", "resume-1"), occurrence("resume-2", "resume-2")],
      cursor: "resume-2",
      hasMore: false,
    });
    return;
  }

  if (mode === "edge" && params.name === "null.event") {
    const first = !timers.has("null-polled");
    timers.set("null-polled", true);
    result(id, {
      events: first ? [occurrence("null-1", null, "null.event")] : [],
      // An absent cursor has the canonical null meaning.
      hasMore: false,
      nextPollMs: 5,
    });
    return;
  }

  result(id, { events: [], cursor, hasMore: false, nextPollMs: 5 });
}

function stream(id, params) {
  streamCount += 1;
  journal({ method: "events/stream", id, params, streamCount });

  if (mode === "dedup") {
    const channel = params.arguments?.channel;
    notify(id, "notifications/events/active", { cursor: `dedup-${channel}-0`, truncated: false });
    notify(id, "notifications/events/event", occurrence("shared-event", `dedup-${channel}-1`));
    if (channel === "one") {
      notify(id, "notifications/events/event", occurrence("shared-event", `dedup-${channel}-1`));
    }
    return;
  }

  if (mode === "edge" && params.name === "truncated.event") {
    notify(id, "notifications/events/active", { cursor: "truncated-1", truncated: true });
    return;
  }

  if (mode === "heartbeat") {
    if (streamCount === 1) {
      notify(id, "notifications/events/active", { cursor: "heartbeat-0", truncated: false });
      const heartbeat = setTimeout(() => {
        notify(id, "notifications/events/heartbeat", { cursor: "heartbeat-1" });
        timers.delete(id);
      }, 5);
      timers.set(id, heartbeat);
    } else {
      notify(id, "notifications/events/active", { cursor: params.cursor ?? null, truncated: false });
      notify(id, "notifications/events/heartbeat", { cursor: params.cursor ?? null });
      const heartbeat = setInterval(() => {
        notify(id, "notifications/events/heartbeat", { cursor: params.cursor ?? null });
      }, 10);
      timers.set(id, heartbeat);
    }
    return;
  }

  const cursor = params.cursor ?? null;
  notify(id, "notifications/events/active", { cursor, truncated: false });
  if (mode === "resume" && streamCount === 1) {
    notify(id, "notifications/events/event", occurrence("resume-1", "resume-1"));
  }
}

function handleRequest(msg) {
  const { id, method, params = {} } = msg;
  const protocol = params._meta?.[META_PROTOCOL];
  if (protocol !== PROTOCOL_VERSION) {
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: [PROTOCOL_VERSION] },
      },
    });
    return;
  }

  switch (method) {
    case "server/discover":
      journal({ method, id, params });
      result(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { extensions: { [EVENTS]: { listChanged: true } } },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "events-fixture", version: "1.0.0" } },
      });
      return;
    case "events/list":
      journal({ method, id, params });
      result(id, { events: descriptors() });
      return;
    case "events/poll":
      poll(id, params);
      return;
    case "events/stream":
      stream(id, params);
      return;
    case "subscriptions/listen": {
      journal({ method, id, params });
      notify(id, "notifications/subscriptions/acknowledged", { notifications: params.notifications ?? {} });
      return;
    }
    default:
      journal({ method, id, params });
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.method === "notifications/cancelled" && !("id" in msg)) {
    const requestId = msg.params?.requestId;
    journal({ method: msg.method, requestId, reason: msg.params?.reason });
    const timer = timers.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      clearInterval(timer);
      timers.delete(requestId);
    }
    return;
  }
  if ("id" in msg && typeof msg.method === "string") handleRequest(msg);
}

const decoder = new StringDecoder("utf8");
let buffer = "";
function drain(flush = false) {
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim()) handleMessage(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
  if (flush && buffer.trim()) handleMessage(JSON.parse(buffer));
}

process.stdin.on("data", chunk => {
  buffer += decoder.write(chunk);
  drain();
});
process.stdin.on("end", () => {
  buffer += decoder.end();
  drain(true);
  process.exit(0);
});
