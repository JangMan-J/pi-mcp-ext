import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createServerClient } from "../src/client.ts";
import { createEventsEngine } from "../src/events.ts";
import { createTasksEngine } from "../src/tasks.ts";
import {
  EXT_TASKS,
  META_LOG_LEVEL,
  type EngineHost,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type Mcp2026Transport,
  type McpLogMessage,
  type ResolvedHttpServer,
} from "../src/types.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, "..");

function piDir(): string {
  const pkgName = (dir: string): string | undefined => {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
    } catch {
      return undefined;
    }
  };
  let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  while (pkgName(dir) !== "@earendil-works/pi-coding-agent") {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Cannot locate @earendil-works/pi-coding-agent");
    dir = parent;
  }
  return dir;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpConfig(url: string): ResolvedHttpServer {
  return {
    name: "spec-server",
    namespace: "mcp__spec_server",
    scope: "global",
    enabled: true,
    timeoutMs: 5_000,
    transport: "http",
    url,
    headers: {},
  };
}

test("SEP-2575: request/openStream logLevel attaches _meta and notifications/message forwards to host.log", async () => {
  const sent: JSONRPCRequest[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const received: JSONRPCNotification[] = [];

  const transport: Mcp2026Transport = {
    kind: "http",
    async request(msg, opts) {
      sent.push(msg);
      if (msg.params?._meta?.[META_LOG_LEVEL]) {
        opts?.onNotification?.({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "warning", logger: "worker", data: "disk nearly full" },
        });
      }
      return { jsonrpc: "2.0", id: msg.id, result: { resultType: "complete" } };
    },
    async openStream(msg, onNotification) {
      sent.push(msg);
      onNotification({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "error", data: { code: "E_BOOM" } },
      });
      return {
        requestId: msg.id,
        cancel: async () => {},
        done: new Promise(() => {}),
      };
    },
    onUnexpectedClose: () => () => {},
    async close() {},
  };

  const client = createServerClient(httpConfig("http://127.0.0.1:1/mcp"), {
    cwd: process.cwd(),
    createTransport: async () => transport,
    log: (level, message) => logs.push({ level, message }),
  });

  assert.equal("discoverCard" in client, false);

  await client.request(
    "tools/call",
    { name: "ping" },
    {
      logLevel: "warning",
      onNotification: (msg) => received.push(msg),
    },
  );
  assert.equal(sent[0].params?._meta?.[META_LOG_LEVEL], "warning");

  await client.request("tools/call", { name: "quiet" });
  assert.equal(META_LOG_LEVEL in (sent[1].params?._meta ?? {}), false);

  const stream = await client.openStream(
    "events/stream",
    { name: "build" },
    (msg) => received.push(msg),
    { logLevel: "error" },
  );
  assert.equal(sent[2].params?._meta?.[META_LOG_LEVEL], "error");
  await stream.cancel();

  assert.equal(received.length, 2);
  assert.deepEqual(logs, [
    { level: "warn", message: "[spec-server/worker] disk nearly full" },
    { level: "error", message: '[spec-server] {"code":"E_BOOM"}' },
  ]);

  client.setListenInterest("events", { eventsListChanged: true });
  client.setListenInterest("tasks", { taskIds: ["t-1", "t-1", "t-2"] });
  await new Promise((r) => setTimeout(r, 10));

  const listen = sent.find((m) => m.method === "subscriptions/listen");
  assert.ok(listen);
  assert.deepEqual(listen.params?.notifications, {
    eventsListChanged: true,
    taskIds: ["t-1", "t-2"],
  });

  await client.close();
});

test("SEP-2575: events.list/poll and tasks.call/get/update/cancel forward logLevel in _meta", async () => {
  const sent: JSONRPCRequest[] = [];
  const client = createServerClient(httpConfig("http://127.0.0.1:1/mcp"), {
    cwd: process.cwd(),
    createTransport: async () => ({
      kind: "http",
      async request(msg) {
        sent.push(msg);
        if (msg.method === "server/discover") {
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              resultType: "complete",
              supportedVersions: ["2026-07-28"],
              capabilities: {
                extensions: {
                  "io.modelcontextprotocol/events": { list: true, poll: true },
                  "io.modelcontextprotocol/tasks": {},
                },
              },
            },
          };
        }
        if (msg.method === "events/list") {
          return { jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", events: [] } };
        }
        if (msg.method === "events/poll") {
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: { resultType: "complete", events: [], cursor: "0", hasMore: false },
          };
        }
        if (msg.method === "tools/call") {
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              resultType: "task",
              taskId: "task-1",
              status: "working",
              ttlMs: 60_000,
              pollIntervalMs: 5_000,
              createdAt: "2026-07-28T00:00:00Z",
              lastUpdatedAt: "2026-07-28T00:00:00Z",
            },
          };
        }
        if (msg.method === "tasks/get") {
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              resultType: "complete",
              taskId: "task-1",
              status: "working",
              ttlMs: 60_000,
              pollIntervalMs: 5_000,
              createdAt: "2026-07-28T00:00:00Z",
              lastUpdatedAt: "2026-07-28T00:00:00Z",
            },
          };
        }
        return { jsonrpc: "2.0", id: msg.id, result: { resultType: "complete" } };
      },
      async openStream(msg) {
        return { requestId: msg.id, cancel: async () => {}, done: new Promise(() => {}) };
      },
      onUnexpectedClose: () => () => {},
      async close() {},
    }),
  });

  await client.discover();
  const ac = new AbortController();
  const host: EngineHost = {
    getClient: (s) => (s === "spec-server" ? client : undefined),
    appendEntry: () => {},
    wake: () => {},
    log: () => {},
    signal: ac.signal,
  };

  const events = createEventsEngine(host);
  const tasks = createTasksEngine(host);

  await events.list("spec-server", { logLevel: "debug" });
  await events.poll("spec-server", { name: "ping", cursor: null }, { logLevel: "notice" });
  await tasks.call("spec-server", "run", { x: 1 }, undefined, { logLevel: "info" });
  await tasks.get("spec-server", "task-1", { logLevel: "warning" });
  await tasks.update("spec-server", "task-1", { k: "v" }, { logLevel: "error" });
  await tasks.cancel("spec-server", "task-1", { logLevel: "critical" });

  const byMethod = new Map(sent.map((m) => [m.method, m.params?._meta?.[META_LOG_LEVEL]]));
  assert.equal(byMethod.get("events/list"), "debug");
  assert.equal(byMethod.get("events/poll"), "notice");
  assert.equal(byMethod.get("tools/call"), "info");
  assert.equal(byMethod.get("tasks/get"), "warning");
  assert.equal(byMethod.get("tasks/update"), "error");
  assert.equal(byMethod.get("tasks/cancel"), "critical");

  await tasks.shutdown();
  await events.shutdown();
  await client.close();
});

test("events engine coalesces concurrent events/list calls and reuses warm cache on subscribe", async () => {
  let listCalls = 0;
  const client = createServerClient(httpConfig("http://127.0.0.1:1/mcp"), {
    cwd: process.cwd(),
    createTransport: async () => ({
      kind: "http",
      async request(msg) {
        if (msg.method === "server/discover") {
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              resultType: "complete",
              supportedVersions: ["2026-07-28"],
              capabilities: {
                extensions: {
                  "io.modelcontextprotocol/events": { listChanged: true },
                },
              },
            },
          };
        }
        if (msg.method === "events/list") {
          listCalls += 1;
          await new Promise((r) => setTimeout(r, 20));
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              resultType: "complete",
              events: [
                { name: "ev.one", delivery: ["push"] },
                { name: "ev.two", delivery: ["push"] },
              ],
            },
          };
        }
        return { jsonrpc: "2.0", id: msg.id, result: { resultType: "complete" } };
      },
      async openStream(msg) {
        return { requestId: msg.id, cancel: async () => {}, done: new Promise(() => {}) };
      },
      onUnexpectedClose: () => () => {},
      async close() {},
    }),
  });

  await client.discover();
  const ac = new AbortController();
  const events = createEventsEngine({
    getClient: () => client,
    appendEntry: () => {},
    wake: () => {},
    log: () => {},
    signal: ac.signal,
  });

  const [a, b, c] = await Promise.all([
    events.list("spec-server"),
    events.list("spec-server"),
    events.list("spec-server"),
  ]);
  assert.equal(listCalls, 1);
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
  assert.equal(c.length, 2);

  await Promise.all([
    events.subscribe({ server: "spec-server", name: "ev.one" }),
    events.subscribe({ server: "spec-server", name: "ev.two" }),
  ]);
  assert.equal(listCalls, 1, "warm descriptorCache avoids duplicate events/list RPCs");

  const seenLogs: McpLogMessage[] = [];
  await events.list("spec-server", { logLevel: "debug", onLog: (entry) => seenLogs.push(entry) });
  assert.equal(listCalls, 2, "explicit logLevel list bypasses coalescing so caller receives logs");
  assert.equal(seenLogs.length, 0);

  await events.shutdown();
  await client.close();
});

test("index.ts e2e: stdio request notifications/message surfaced via logLevel, -32021 hint, instant settle drain, and mcp_servers_change reaps removed stdio server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "suite6-e2e-"));
  const agentDir = join(dir, "agent");
  const projectDir = join(dir, "project");
  const pidFile = join(dir, "server.pid");
  const serverScript = join(dir, "stdio-2026-server.mjs");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    serverScript,
    `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const SUB_ID = "io.modelcontextprotocol/subscriptionId";
const LOG_KEY = "io.modelcontextprotocol/logLevel";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (!("id" in req)) return;
  const logLevel = req.params?._meta?.[LOG_KEY];
  if (logLevel) {
    send({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: logLevel, logger: "trace", data: "handled " + req.method },
    });
  }
  if (req.method === "server/discover") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/events": { listChanged: true },
            "io.modelcontextprotocol/tasks": {},
          },
        },
      },
    });
    return;
  }
  if (req.method === "subscriptions/listen") {
    send({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: req.params?.notifications ?? {},
        _meta: { [SUB_ID]: req.id },
      },
    });
    return;
  }
  if (req.method === "events/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        resultType: "complete",
        events: [{ name: "tick", delivery: ["push"] }],
      },
    });
    return;
  }
  if (req.method === "events/stream") {
    send({
      jsonrpc: "2.0",
      method: "notifications/events/active",
      params: { cursor: "c-live", _meta: { [SUB_ID]: req.id } },
    });
    return;
  }
  if (req.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "ok" }],
      },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: req.id, result: { resultType: "complete" } });
});
`,
  );

  const mcpJsonPath = join(agentDir, "mcp.json");
  writeFileSync(
    mcpJsonPath,
    JSON.stringify({
      mcpServers: {
        "live-stdio": {
          command: process.execPath,
          args: [serverScript, "--ignore-eof"],
        },
      },
    }),
  );

  const pi = piDir();
  const loader: any = await import(pathToFileURL(join(pi, "dist/core/extensions/loader.js")).href);
  const runnerMod: any = await import(pathToFileURL(join(pi, "dist/core/extensions/runner.js")).href);
  const runtime = loader.createExtensionRuntime();
  const loaded = await loader.loadExtensions([resolve(rootDir, "src/index.ts")], projectDir, undefined, runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];

  const sessionEntries: any[] = [];
  const sessionManager: any = {
    getBranch: () => [...sessionEntries],
    getEntries: () => [...sessionEntries],
    getSessionFile: () => undefined,
  };
  const modelRegistry: any = {
    getProviderAuth: async () => undefined,
    registerProvider: () => {},
  };
  const runner = new runnerMod.ExtensionRunner(
    loaded.extensions,
    runtime,
    projectDir,
    sessionManager,
    modelRegistry,
  );
  runner.bindCore(
    {
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: (customType: string, data: unknown) => {
        sessionEntries.push({ type: "custom", customType, data });
      },
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      getSettings: () => ({}),
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: async () => false,
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => false,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
      executeTool: async () => {
        throw new Error("unused");
      },
    },
  );
  runner.setUIContext(undefined, "print");

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await runner.emit({ type: "session_start", reason: "startup" });

    const eventsTool = extension.tools.get("mcp_events").definition;
    const tasksTool = extension.tools.get("mcp_tasks").definition;
    const ctx = runner.createToolContext("call-1", undefined);

    // 1. SEP-2575 debug/info logs over stdio request are returned in content[1] without tainting JSON in content[0].
    const listRes = await eventsTool.execute(
      "call-1",
      { action: "list", server: "live-stdio", logLevel: "debug" },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(JSON.parse(listRes.content[0].text), [{ name: "tick", delivery: ["push"] }]);
    assert.equal(listRes.content[1]?.text, "[live-stdio/trace] (debug) handled events/list");

    const callRes = await tasksTool.execute(
      "call-2",
      { action: "call", server: "live-stdio", tool: "fast", arguments: { n: 1 }, logLevel: "info" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(JSON.parse(callRes.content[0].text).resultType, "complete");
    assert.equal(callRes.content[1]?.text, "[live-stdio/trace] (info) handled tools/call");

    // 2. -32021 tool_result interceptor appends exact mcp_tasks hint.
    const hintRes = await runner.emitToolResult({
      type: "tool_result",
      toolCallId: "tc-1",
      toolName: "mcp__live_stdio__heavy_job",
      input: { target: "prod" },
      content: [{ type: "text", text: `MCP error -32021: missing ${EXT_TASKS}` }],
      isError: true,
    });
    assert.ok(hintRes?.content);
    const hintedText = hintRes.content.map((b: any) => b.text).join("\n");
    assert.match(hintedText, /Hint: Tool "heavy_job" on MCP server "live-stdio" requires io\.modelcontextprotocol\/tasks; use mcp_tasks /);
    assert.match(hintedText, /"target":"prod"/);

    // 3. Zero-poll agent_before_settle releases immediately on unsubscribe (<50ms).
    await eventsTool.execute(
      "call-3",
      { action: "subscribe", server: "live-stdio", name: "tick", holdSettle: true },
      undefined,
      undefined,
      ctx,
    );
    let settleDone = false;
    const settlePromise = runner
      .emitBoundary({ type: "agent_before_settle", outcome: "completed" }, async () => ({}))
      .then((res: any) => {
        settleDone = true;
        return res;
      });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settleDone, false);

    const t0 = performance.now();
    await eventsTool.execute(
      "call-4",
      { action: "unsubscribe", server: "live-stdio", name: "tick" },
      undefined,
      undefined,
      ctx,
    );
    await settlePromise;
    const elapsedMs = performance.now() - t0;
    assert.equal(settleDone, true);
    assert.ok(elapsedMs < 80, `expected instant event-driven settle drain, took ${elapsedMs.toFixed(1)}ms`);

    // 4. mcp_servers_change removing live-stdio closes client and reaps child pid without waiting for session_shutdown.
    const serverPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.equal(isPidAlive(serverPid), true);

    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }));
    await runner.emit({ type: "mcp_servers_change", servers: [] });

    for (let i = 0; i < 40 && isPidAlive(serverPid); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(isPidAlive(serverPid), false, "removed stdio server must be reaped immediately on mcp_servers_change");
  } finally {
    await runnerMod.emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "quit" });
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
