#!/usr/bin/env node
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId";
const ignoreEof = process.argv.includes("--ignore-eof");
const spawnSubchild = process.argv.includes("--spawn-subchild");

let subchildPid = null;
if (spawnSubchild) {
  const sub = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
    stdio: "ignore",
  });
  subchildPid = sub.pid ?? null;
}

if (ignoreEof) {
  process.on("SIGTERM", () => {
    process.exit(0);
  });
}

const decoder = new StringDecoder("utf8");
let buffer = "";
const activeTimers = new Map();
const cancelled = [];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function clearTimersFor(id) {
  const timers = activeTimers.get(id);
  if (timers) {
    for (const timer of timers) clearTimeout(timer);
    activeTimers.delete(id);
  }
}

function addTimer(id, timer) {
  let list = activeTimers.get(id);
  if (!list) {
    list = [];
    activeTimers.set(id, list);
  }
  list.push(timer);
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.method === "notifications/cancelled" && !("id" in msg)) {
    const entry = msg.params ?? {};
    cancelled.push(entry);
    process.stderr.write(`cancelled:${JSON.stringify(entry)}\n`);
    if (entry.requestId !== undefined) {
      clearTimersFor(entry.requestId);
    }
    return;
  }

  if (!("id" in msg) || typeof msg.method !== "string") return;

  const { id, method, params = {} } = msg;

  if (method === "test/stream") {
    const items = Array.isArray(params.items) ? params.items : ["alpha", "beta"];
    if (params.emitUnmatched) {
      send({
        jsonrpc: "2.0",
        method: "notifications/test/item",
        params: { item: "untagged" },
      });
      send({
        jsonrpc: "2.0",
        method: "notifications/test/item",
        params: {
          item: "other-stream",
          _meta: { [SUBSCRIPTION_ID_KEY]: "non-existent-sub" },
        },
      });
    }
    for (const item of items) {
      send({
        jsonrpc: "2.0",
        method: "notifications/test/item",
        params: {
          item,
          _meta: { [SUBSCRIPTION_ID_KEY]: id },
        },
      });
    }
    if (params.holdOpen) {
      const hold = setTimeout(() => {}, 60_000);
      addTimer(id, hold);
      return;
    }
    if (params.error) {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: params.error.code ?? -32023,
          message: params.error.message ?? "Stream failed",
          ...(params.error.data !== undefined ? { data: params.error.data } : {}),
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: { resultType: "complete", count: items.length },
    });
    return;
  }

  if (method === "test/slow") {
    const steps = typeof params.steps === "number" ? params.steps : 3;
    const intervalMs = typeof params.intervalMs === "number" ? params.intervalMs : 45;
    const progressToken =
      params?._meta?.progressToken ?? params?.progressToken ?? id;

    for (let step = 1; step <= steps; step += 1) {
      const timer = setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken,
            progress: step,
            total: steps,
          },
        });
        if (step === steps) {
          activeTimers.delete(id);
          send({
            jsonrpc: "2.0",
            id,
            result: { ok: true, steps },
          });
        }
      }, step * intervalMs);
      addTimer(id, timer);
    }
    return;
  }

  if (method === "test/hang") {
    const hold = setTimeout(() => {}, 60_000);
    addTimer(id, hold);
    return;
  }

  if (method === "test/rpc-error") {
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: params.code ?? -32601,
        message: params.message ?? "Method not found",
      },
    });
    return;
  }

  if (method === "test/crash") {
    if (typeof params.stderr === "string") {
      process.stderr.write(params.stderr);
    }
    process.exit(typeof params.code === "number" ? params.code : 1);
  }

  if (params.stderrNoise) {
    process.stderr.write(`${String(params.stderrNoise)}\n`);
  }

  send({
    jsonrpc: "2.0",
    id,
    result: {
      echo: { method, params },
      pid: process.pid,
      subchildPid,
      cwd: process.cwd(),
      envValue: process.env.MCP_TEST_ENV ?? null,
      cancelled,
    },
  });
}

function drainLines(flush = false) {
  let idx = buffer.indexOf("\n");
  while (idx !== -1) {
    let line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length > 0) {
      handleMessage(JSON.parse(line));
    }
    idx = buffer.indexOf("\n");
  }
  if (flush && buffer.trim().length > 0) {
    let line = buffer;
    buffer = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    handleMessage(JSON.parse(line));
  }
}

process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  drainLines(false);
});

process.stdin.on("end", () => {
  buffer += decoder.end();
  drainLines(true);
  if (!ignoreEof) {
    process.exit(0);
  }
});

if (ignoreEof) {
  setInterval(() => {}, 10_000);
}
