#!/usr/bin/env node
/**
 * Canonical SEP-2663 (io.modelcontextprotocol/tasks) MCP 2026-07-28 stdio fixture server.
 *
 * Speaks newline-delimited JSON-RPC on stdio:
 *   server/discover      -> advertises io.modelcontextprotocol/tasks
 *   tools/call           -> resultType "complete" for `instant`, resultType "task" for the rest
 *   tasks/get|update|cancel
 *   subscriptions/listen -> notifications/subscriptions/acknowledged + notifications/tasks
 *
 * Every received message is appended as one JSON line to the file named by MCP_FIXTURE_LOG
 * (or --log <file>), prefixed by a {"method":"__ready","pid":...} line, so tests can assert
 * exactly what crossed the wire (including any notifications/cancelled).
 *
 * Ack behaviour is selected with TASKS_FIXTURE_ACK:
 *   honor    (default) acknowledge the requested taskIds immediately
 *   withhold acknowledge with an empty filter (forces tasks/get polling fallback)
 *   delay    acknowledge the requested taskIds after TASKS_FIXTURE_ACK_DELAY_MS (default 400)
 *
 * Tools:
 *   instant     -> completes synchronously (resultType "complete")
 *   slow        -> task; completes after arguments.delayMs (default 300).
 *                  arguments.toolError=true finishes status "completed" with result.isError=true
 *   faulty      -> task; becomes status "failed" (JSON-RPC error -32603) after delayMs
 *   needs-input -> task in input_required with one inputRequests key "approval";
 *                  tasks/update answering it completes the task shortly after
 *   vanish      -> task that tasks/get reports as -32602 (unknown/expired)
 *   hang        -> task that stays working until cancelled
 * Any tool accepts arguments.pollIntervalMs (default 50).
 */
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId";
const PROTOCOL_VERSION = "2026-07-28";

const logArg = process.argv.indexOf("--log");
const LOG_FILE = process.env.MCP_FIXTURE_LOG ?? (logArg >= 0 ? process.argv[logArg + 1] : undefined);
const ACK_MODE = process.env.TASKS_FIXTURE_ACK ?? "honor";
const ACK_DELAY_MS = Number(process.env.TASKS_FIXTURE_ACK_DELAY_MS ?? 400);

function logReceived(entry) {
  if (!LOG_FILE) return;
  try {
    appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never break the protocol.
  }
}
logReceived({ method: "__ready", pid: process.pid });

let lastStampMs = 0;
function stamp() {
  const now = Date.now();
  lastStampMs = now > lastStampMs ? now : lastStampMs + 1;
  return new Date(lastStampMs).toISOString();
}

/** taskId -> task record (internal fields prefixed with _) */
const tasks = new Map();
/** listen requestId -> { honoredTaskIds: Set<string>, ackTimer } */
const streams = new Map();
let taskSeq = 0;

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function baseTask(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: null,
    pollIntervalMs: task.pollIntervalMs,
  };
}

/** Full DetailedTask snapshot for tasks/get results and notifications/tasks params. */
function detailed(task) {
  const snap = baseTask(task);
  if (task.status === "input_required") snap.inputRequests = structuredClone(task.inputRequests);
  if (task.status === "completed") snap.result = structuredClone(task.result);
  if (task.status === "failed") snap.error = structuredClone(task.error);
  return snap;
}

function notifyTask(task) {
  for (const [streamId, stream] of streams) {
    if (!stream.honoredTaskIds.has(task.taskId)) continue;
    send({
      jsonrpc: "2.0",
      method: "notifications/tasks",
      params: { ...detailed(task), _meta: { [SUBSCRIPTION_ID_KEY]: streamId } },
    });
  }
}

function transition(task, status, extra = {}) {
  if (["completed", "failed", "cancelled"].includes(task.status)) return;
  Object.assign(task, extra, { status, lastUpdatedAt: stamp() });
  notifyTask(task);
}

function createTask(toolName, args) {
  taskSeq += 1;
  const createdAt = stamp();
  const task = {
    taskId: `task-${taskSeq}`,
    status: "working",
    createdAt,
    lastUpdatedAt: createdAt,
    pollIntervalMs: typeof args.pollIntervalMs === "number" ? args.pollIntervalMs : 50,
    _tool: toolName,
    _timer: undefined,
  };
  tasks.set(task.taskId, task);

  const delayMs = typeof args.delayMs === "number" ? args.delayMs : 300;
  if (toolName === "slow") {
    task._timer = setTimeout(() => {
      const isError = args.toolError === true;
      transition(task, "completed", {
        result: {
          content: [{ type: "text", text: isError ? "tool blew up" : (typeof args.text === "string" ? args.text : "done") }],
          ...(isError ? { isError: true } : {}),
        },
      });
    }, delayMs);
  } else if (toolName === "faulty") {
    task._timer = setTimeout(() => {
      transition(task, "failed", { error: { code: -32603, message: "underlying request fault" } });
    }, delayMs);
  } else if (toolName === "needs-input") {
    task.status = "input_required";
    task.inputRequests = {
      approval: {
        method: "elicitation/create",
        params: { message: "Approve?", requestedSchema: { type: "object", properties: {} } },
      },
    };
  } else if (toolName === "vanish") {
    task._vanished = true;
  }
  // "hang" never transitions on its own.
  return task;
}

function handleDiscover(id) {
  reply(id, {
    resultType: "complete",
    supportedVersions: [PROTOCOL_VERSION],
    capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "tasks-fixture", version: "1.0.0" } },
  });
}

function handleToolsCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name === "instant") {
    reply(id, { resultType: "complete", content: [{ type: "text", text: "instant done" }] });
    return;
  }
  if (!["slow", "faulty", "needs-input", "vanish", "hang"].includes(name)) {
    replyError(id, -32602, `unknown tool: ${String(name)}`);
    return;
  }
  const task = createTask(name, args);
  reply(id, { resultType: "task", ...baseTask(task) });
}

function handleTasksGet(id, params) {
  const task = tasks.get(params?.taskId);
  if (!task || task._vanished) {
    replyError(id, -32602, "unknown or expired taskId");
    return;
  }
  reply(id, { resultType: "complete", ...detailed(task) });
}

function handleTasksUpdate(id, params) {
  const task = tasks.get(params?.taskId);
  if (!task || task._vanished) {
    replyError(id, -32602, "unknown or expired taskId");
    return;
  }
  const responses = params?.inputResponses ?? {};
  if (task.status === "input_required") {
    for (const key of Object.keys(responses)) delete task.inputRequests[key];
    if (Object.keys(task.inputRequests).length === 0) {
      transition(task, "working");
      task._timer = setTimeout(() => {
        transition(task, "completed", {
          result: { content: [{ type: "text", text: "input accepted" }] },
        });
      }, 120);
    }
  }
  reply(id, { resultType: "complete" });
}

function handleTasksCancel(id, params) {
  const task = tasks.get(params?.taskId);
  if (task) {
    if (task._timer) clearTimeout(task._timer);
    transition(task, "cancelled");
  }
  reply(id, { resultType: "complete" });
}

function handleListen(id, params) {
  const requested = Array.isArray(params?.notifications?.taskIds) ? params.notifications.taskIds : [];
  const stream = { honoredTaskIds: new Set(), ackTimer: undefined };
  streams.set(id, stream);
  const acknowledge = () => {
    if (!streams.has(id)) return;
    const honored = ACK_MODE === "withhold" ? [] : requested;
    stream.honoredTaskIds = new Set(honored);
    send({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: honored.length ? { taskIds: honored } : {},
        _meta: { [SUBSCRIPTION_ID_KEY]: id },
      },
    });
  };
  if (ACK_MODE === "delay") stream.ackTimer = setTimeout(acknowledge, ACK_DELAY_MS);
  else acknowledge();
  // The listen request itself stays open until the client cancels it.
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return;
  logReceived({
    method: msg.method,
    ...("id" in msg ? { id: msg.id } : {}),
    params: msg.params ?? {},
  });

  if (msg.method === "notifications/cancelled") {
    const requestId = msg.params?.requestId;
    const stream = streams.get(requestId);
    if (stream) {
      if (stream.ackTimer) clearTimeout(stream.ackTimer);
      streams.delete(requestId);
    }
    return;
  }
  if (!("id" in msg)) return; // other notifications need no answer

  switch (msg.method) {
    case "server/discover": handleDiscover(msg.id); break;
    case "tools/call": handleToolsCall(msg.id, msg.params); break;
    case "tools/list":
      reply(msg.id, {
        resultType: "complete",
        tools: ["instant", "slow", "faulty", "needs-input", "vanish", "hang"].map((name) => ({
          name,
          inputSchema: { type: "object", properties: {} },
        })),
      });
      break;
    case "tasks/get": handleTasksGet(msg.id, msg.params); break;
    case "tasks/update": handleTasksUpdate(msg.id, msg.params); break;
    case "tasks/cancel": handleTasksCancel(msg.id, msg.params); break;
    case "subscriptions/listen": handleListen(msg.id, msg.params); break;
    default: replyError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

const decoder = new StringDecoder("utf8");
let buffer = "";
function drainLines(flush = false) {
  let idx = buffer.indexOf("\n");
  while (idx !== -1) {
    let line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim()) handleMessage(JSON.parse(line));
    idx = buffer.indexOf("\n");
  }
  if (flush && buffer.trim()) {
    const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    buffer = "";
    handleMessage(JSON.parse(line));
  }
}
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  drainLines();
});
process.stdin.on("end", () => {
  buffer += decoder.end();
  drainLines(true);
  process.exit(0);
});
