/**
 * Spec §9 suite 5: Tasks State Machine & Headless Settle Check (SEP-2663).
 *
 * Drives the real modules (createServerClient + createTasksEngine, and for the settle
 * check the full extension through Pi's ExtensionRunner) against a real stdio subprocess
 * running tests/fixtures/tasks-server.mjs. The fixture logs every received wire message
 * to a file, which is how listen-stream, polling, and cancellation behaviour is asserted.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServerClient } from "../src/client.ts";
import { createTasksEngine } from "../src/tasks.ts";
import type { EngineHost, ResolvedServer } from "../src/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "tests/fixtures/tasks-server.mjs");
const SERVER = "tasksrv";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

interface LogEntry {
  method: string;
  id?: string | number;
  pid?: number;
  params?: Record<string, any>;
}

function fixtureConfig(logFile: string, ack: string, extraEnv: Record<string, string> = {}): ResolvedServer {
  return {
    name: SERVER,
    namespace: "mcp__tasksrv",
    scope: "global",
    enabled: true,
    timeoutMs: 5000,
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    env: { MCP_FIXTURE_LOG: logFile, TASKS_FIXTURE_ACK: ack, ...extraEnv },
  };
}

/** Real client + real tasks engine over a real stdio subprocess, with an in-test EngineHost. */
async function startEngine(ack: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "suite5-"));
  const logFile = join(dir, "wire.log");
  writeFileSync(logFile, "");
  const client = createServerClient(fixtureConfig(logFile, ack, extraEnv), { cwd: root });
  const wakes: Array<{ customType: string; content: string }> = [];
  const entries: unknown[] = [];
  const controller = new AbortController();
  const host: EngineHost = {
    getClient: (name) => (name === SERVER ? client : undefined),
    appendEntry: (_customType, data) => { entries.push(data); },
    wake: (customType, content) => { wakes.push({ customType, content }); },
    log: () => {},
    signal: controller.signal,
  };
  const engine = createTasksEngine(host, { pollFloorMs: 10, defaultPollMs: 50 });
  const state = await client.discover();
  assert.equal(state.era, "modern", `discover era: ${state.era} ${state.error ?? ""}`);
  assert.equal(state.tasks, true);
  engine.serverReady(SERVER);

  const log = (): LogEntry[] =>
    readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LogEntry);
  const count = (method: string) => log().filter((e) => e.method === method).length;
  const cleanup = async () => {
    await engine.shutdown();
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { client, engine, wakes, entries, log, count, cleanup };
}

test("task subscribes on the single listen stream; polling runs while unacknowledged and pauses once acknowledged", async () => {
  const s = await startEngine("delay", { TASKS_FIXTURE_ACK_DELAY_MS: "500" });
  try {
    const outcome: any = await s.engine.call(SERVER, "hang", { pollIntervalMs: 30 });
    assert.equal(outcome.resultType, "task");
    const taskId = outcome.taskId as string;

    // Exactly one subscriptions/listen stream, carrying exactly this taskId.
    await waitFor(() => s.count("subscriptions/listen") >= 1, "listen stream opened");
    const listens = s.log().filter((e) => e.method === "subscriptions/listen");
    assert.equal(listens.length, 1);
    assert.deepEqual(listens[0].params?.notifications?.taskIds, [taskId]);

    // Ack is delayed 500 ms: pollIntervalMs tasks/get fallback must be running meanwhile.
    await waitFor(() => s.count("tasks/get") >= 2, "fallback polling before ack");

    // After the ack honors the taskId, polling pauses.
    await sleep(650);
    const afterAck = s.count("tasks/get");
    await sleep(300);
    assert.equal(s.count("tasks/get"), afterAck, "tasks/get kept polling after acknowledgment");
    assert.equal(s.count("subscriptions/listen"), 1, "more than one listen stream was opened");
    assert.equal(s.engine.hasPending(), true);
  } finally {
    await s.cleanup();
  }
});

test("input_required dedups repeated inputRequests keys across polls and fulfils via tasks/update", async () => {
  const s = await startEngine("withhold"); // empty ack => polling drives every snapshot
  try {
    const outcome: any = await s.engine.call(SERVER, "needs-input", { pollIntervalMs: 30 });
    const taskId = outcome.taskId as string;

    await waitFor(() => s.wakes.length >= 1, "input_required wake");
    assert.match(s.wakes[0].content, /input_required/);
    assert.match(s.wakes[0].content, /Untrusted input requests/);
    assert.match(s.wakes[0].content, /approval/);

    // Several more polls return the same outstanding key: still exactly one wake.
    await waitFor(() => s.count("tasks/get") >= 4, "repeated polls");
    assert.equal(s.wakes.filter((w) => w.content.includes(taskId)).length, 1);

    await s.engine.update(SERVER, taskId, { approval: { action: "accept", content: {} } });
    const updates = s.log().filter((e) => e.method === "tasks/update");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].params?.taskId, taskId);
    assert.deepEqual(updates[0].params?.inputResponses, { approval: { action: "accept", content: {} } });

    await waitFor(() => s.wakes.length >= 2, "completion wake after update");
    assert.match(s.wakes[1].content, /completed/);
    assert.match(s.wakes[1].content, /input accepted/);
    assert.equal(s.engine.active().find((r) => r.taskId === taskId)?.status, "completed");
  } finally {
    await s.cleanup();
  }
});

test("isError tool result arrives as status completed; JSON-RPC fault as status failed", async () => {
  const s = await startEngine("honor");
  try {
    // A synchronous tool still returns resultType "complete" and is not tracked.
    const instant: any = await s.engine.call(SERVER, "instant", {});
    assert.equal(instant.resultType, "complete");
    assert.equal(s.engine.active().length, 0);

    const toolErr: any = await s.engine.call(SERVER, "slow", { delayMs: 80, toolError: true });
    await waitFor(() => s.wakes.some((w) => w.content.includes(toolErr.taskId)), "tool-error wake");
    const errWake = s.wakes.find((w) => w.content.includes(toolErr.taskId))!;
    assert.match(errWake.content, /: completed/);
    assert.match(errWake.content, /Tool error \(isError: true; status completed\)/);
    assert.equal(s.engine.active().find((r) => r.taskId === toolErr.taskId)?.status, "completed");

    const fault: any = await s.engine.call(SERVER, "faulty", { delayMs: 80 });
    await waitFor(() => s.wakes.some((w) => w.content.includes(fault.taskId)), "fault wake");
    const faultWake = s.wakes.find((w) => w.content.includes(fault.taskId))!;
    assert.match(faultWake.content, /: failed/);
    assert.match(faultWake.content, /JSON-RPC error: \{"code":-32603/);
    assert.equal(s.engine.active().find((r) => r.taskId === fault.taskId)?.status, "failed");
    assert.equal(s.engine.hasPending(), false);
  } finally {
    await s.cleanup();
  }
});

test("-32602 on tasks/get marks the task not_found_or_expired and wakes once", async () => {
  const s = await startEngine("withhold");
  try {
    const outcome: any = await s.engine.call(SERVER, "vanish", { pollIntervalMs: 30 });
    const taskId = outcome.taskId as string;
    await waitFor(
      () => s.engine.active().find((r) => r.taskId === taskId)?.status === "not_found_or_expired",
      "not_found_or_expired status",
    );
    assert.equal(s.wakes.filter((w) => w.content.includes(taskId)).length, 1);
    assert.match(s.wakes.find((w) => w.content.includes(taskId))!.content, /not_found_or_expired/);
    assert.equal(s.engine.hasPending(), false);

    // A further explicit get still surfaces the -32602 but does not wake again.
    await assert.rejects(s.engine.get(SERVER, taskId), /unknown or expired taskId/);
    assert.equal(s.wakes.filter((w) => w.content.includes(taskId)).length, 1);
  } finally {
    await s.cleanup();
  }
});

test("tasks/cancel never sends notifications/cancelled for the task", async () => {
  const s = await startEngine("honor");
  try {
    const a: any = await s.engine.call(SERVER, "hang", {});
    const b: any = await s.engine.call(SERVER, "hang", {});
    await sleep(250); // let the listen-filter replacement for B settle

    await s.engine.cancel(SERVER, a.taskId);
    await waitFor(() => s.count("tasks/cancel") >= 1, "tasks/cancel on the wire");
    await sleep(250); // let any listen-stream replacement play out

    const entries = s.log();
    const cancels = entries.filter((e) => e.method === "tasks/cancel");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].params?.taskId, a.taskId);

    // The only notifications/cancelled ever sent retire subscriptions/listen streams;
    // none targets a tools/call (or any task) request id.
    const listenIds = new Set(entries.filter((e) => e.method === "subscriptions/listen").map((e) => e.id));
    const toolCallIds = new Set(entries.filter((e) => e.method === "tools/call").map((e) => e.id));
    for (const cancelled of entries.filter((e) => e.method === "notifications/cancelled")) {
      assert.ok(listenIds.has(cancelled.params?.requestId), `notifications/cancelled for non-listen request ${String(cancelled.params?.requestId)}`);
      assert.ok(!toolCallIds.has(cancelled.params?.requestId));
    }

    assert.equal(s.engine.active().find((r) => r.taskId === a.taskId)?.status, "cancelled");
    assert.equal(s.wakes.some((w) => w.content.includes(a.taskId)), false, "locally cancelled task woke the model");
    assert.equal(s.engine.hasPending(), true, "second hang task should still be pending");
    void b;
  } finally {
    await s.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Headless settle: the full extension through Pi's real loader + ExtensionRunner.
// ---------------------------------------------------------------------------------------------

function piDir(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
    } catch { /* not the package root yet */ }
    if (dirname(dir) === dir) throw new Error("Cannot find the installed @earendil-works/pi-coding-agent");
    dir = dirname(dir);
  }
}

test("headless settle: agent_before_settle holds in print mode until the task completes, shutdown reaps the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "suite5-agent-"));
  const agentDir = join(dir, "agent");
  const projectDir = join(dir, "project");
  const logFile = join(dir, "wire.log");
  writeFileSync(logFile, "");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      [SERVER]: {
        command: process.execPath,
        args: [fixture],
        env: { MCP_FIXTURE_LOG: logFile, TASKS_FIXTURE_ACK: "honor" },
      },
    },
  }));

  const pi = piDir();
  const loader: any = await import(pathToFileURL(join(pi, "dist/core/extensions/loader.js")).href);
  const runnerMod: any = await import(pathToFileURL(join(pi, "dist/core/extensions/runner.js")).href);
  const runtime = loader.createExtensionRuntime();
  const loaded = await loader.loadExtensions([resolve(root, "src/index.ts")], projectDir, undefined, runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.ok(extension.tools.has("mcp_tasks"), "mcp_tasks tool registered");

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
  const runner = new runnerMod.ExtensionRunner(loaded.extensions, runtime, projectDir, sessionManager, modelRegistry);
  const runnerErrors: any[] = [];
  runner.onError((e: any) => runnerErrors.push(e));

  const sentMessages: Array<{ message: any; options: any }> = [];
  runner.bindCore(
    {
      sendMessage: (message: any, options: any) => { sentMessages.push({ message, options }); },
      sendUserMessage: () => {},
      appendEntry: (customType: string, data: unknown) => { sessionEntries.push({ type: "custom", customType, data }); },
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
      hasPendingMessages: () => sentMessages.length > 0,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
      executeTool: async () => { throw new Error("nested tool execution not used in this test"); },
    },
  );
  runner.setUIContext(undefined, "print");
  assert.equal(runner.createContext().mode, "print");

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await runner.emit({ type: "session_start", reason: "startup" });

    const tool = extension.tools.get("mcp_tasks").definition;
    const ctx = runner.createToolContext("call-1", undefined);
    const callResult = await tool.execute(
      "call-1",
      { action: "call", server: SERVER, tool: "slow", arguments: { delayMs: 700, text: "settled-result" } },
      undefined,
      undefined,
      ctx,
    );
    const outcome = JSON.parse(callResult.content[0].text);
    assert.equal(outcome.resultType, "task");
    assert.equal(typeof outcome.taskId, "string");

    // The settle boundary must hold while the task is still working...
    let settleResolved = false;
    const settlePromise = runner
      .emitBoundary({ type: "agent_before_settle", outcome: "completed" }, async () => ({}))
      .then((r: any) => { settleResolved = true; return r; });
    await sleep(300);
    assert.equal(settleResolved, false, "agent_before_settle returned before the task completed");
    assert.equal(sentMessages.length, 0);

    // ...and release with continue:true only after the steered mcp-task wake was sent.
    const settle = await settlePromise;
    assert.equal(settle.continue, true);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].message.customType, "mcp-task");
    assert.match(sentMessages[0].message.content, /: completed/);
    assert.match(sentMessages[0].message.content, /settled-result/);
    assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });
    assert.deepEqual(runnerErrors, []);

    // session_shutdown reaps the stdio child.
    const ready = readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).find((e: any) => e.method === "__ready");
    assert.equal(typeof ready?.pid, "number");
    const emitted = await runnerMod.emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "quit" });
    assert.equal(emitted, true);
    await waitFor(() => {
      try {
        process.kill(ready.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "fixture child process reaped", 3000);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
  // No timers or children remain: node --test exiting promptly is the final assertion.
});
