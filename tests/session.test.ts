import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createMcpSession, type McpSession } from "../src/session.ts";
import { CUSTOM_TASKS, McpTransportError, type ConfigLoadOptions } from "../src/types.ts";

const FIXTURE = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
const LOG_KEY = "io.modelcontextprotocol/logLevel";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");

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
  const skillsDelay = process.env.FIXTURE_SKILLS_DELAY_MS;
  if (req.method === "server/discover") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: skillsDelay
          ? { resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } }
          : { resources: {} },
        ...(skillsDelay ? { instructions: "pid " + process.pid } : {}),
      },
    });
    return;
  }
  if (req.method === "skills/list") {
    const skill = {
      uri: "skill://slow/SKILL.md",
      frontmatter: { name: "slow", description: "pid " + process.pid },
      resources: "dynamic",
    };
    setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result: { resultType: "complete", skills: [skill], ttlMs: 60000 } }), Number(skillsDelay));
    return;
  }
  if (req.method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { resultType: "complete", resources: [{ uri: "file:///a.txt", name: "a" }] },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: req.id, result: { resultType: "complete" } });
});
`;

interface Harness {
  dir: string;
  projectDir: string;
  pidFile: string;
  writeConfig(servers: Record<string, unknown>): void;
  loadOptions(): ConfigLoadOptions;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  appended: Array<{ customType: string; data: unknown }>;
  restoreEnv(): void;
}

function setup(prefix: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const agentDir = join(dir, "agent");
  const projectDir = join(dir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const script = join(dir, "fixture-server.mjs");
  const pidFile = join(dir, "server.pid");
  writeFileSync(script, FIXTURE);

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
    sendMessage: () => {},
    sendUserMessage: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
    registerTool: () => {},
    registerCommand: () => {},
    getMcpServers: () => [],
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: projectDir,
    hasUI: false,
    mode: "print",
    signal: undefined,
    isProjectTrusted: () => false,
    hasPendingMessages: () => false,
    modelRegistry: { getProviderAuth: async () => undefined },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  } as unknown as ExtensionContext;

  const server = (extra: Record<string, unknown> = {}) => ({
    command: process.execPath,
    args: [script],
    env: { FIXTURE_PID_FILE: pidFile },
    ...extra,
  });

  return {
    dir,
    projectDir,
    pidFile,
    writeConfig(servers) {
      const resolved: Record<string, unknown> = {};
      for (const [name, extra] of Object.entries(servers)) {
        resolved[name] = server(extra as Record<string, unknown>);
      }
      writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: resolved }));
    },
    loadOptions: () => ({ cwd: projectDir, isProjectTrusted: false, sessionServers: [] }),
    ctx,
    pi,
    appended,
    restoreEnv() {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    },
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && isPidAlive(pid); i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isPidAlive(pid);
}

test("createMcpSession: reconcile, servers, withServer (logs, rejections, needs-auth), reap on reload, shutdown", async () => {
  const h = setup("session-seam-");
  let session: McpSession | undefined;
  try {
    h.writeConfig({ fx: {}, off: { enabled: false } });
    session = createMcpSession(h.pi, h.ctx);
    assert.equal(session.signal.aborted, false);

    await session.reconcile(h.loadOptions());
    const states = await session.servers();
    assert.deepEqual(
      states.map((s) => [s.name, s.era]),
      [
        ["fx", "modern"],
        ["off", "disabled"],
      ],
    );
    assert.equal(states[0].resources, true);

    // Request-scoped logs are collected through scope.logOpts and formatted.
    const listed = await session.withServer(
      { server: "fx", capability: "resources", logLevel: "info", ctx: h.ctx },
      async ({ client, logOpts }) => {
        assert.equal(client.name, "fx");
        return session!.resources.list("fx", undefined, logOpts);
      },
    );
    assert.deepEqual(
      listed.value.resources.map((r) => r.uri),
      ["file:///a.txt"],
    );
    assert.deepEqual(listed.logs, ["[fx/trace] (info) handled resources/list"]);

    // Without logLevel no logs are requested.
    const quiet = await session.withServer({ server: "fx" }, async ({ logOpts }) =>
      session!.resources.list("fx", undefined, logOpts),
    );
    assert.deepEqual(quiet.logs, []);

    // Rejections never invoke fn.
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return "ran";
    };
    await assert.rejects(
      session.withServer({ server: "nope" }, fn),
      { message: 'Unknown MCP server "nope". Configured servers: fx, off.' },
    );
    await assert.rejects(session.withServer({ server: "off" }, fn), {
      message: 'MCP server "off" is disabled.',
    });
    await assert.rejects(session.withServer({ server: "fx", capability: "events" }, fn), {
      message: 'MCP server "fx" does not advertise io.modelcontextprotocol/events.',
    });
    await assert.rejects(session.withServer({ server: "fx", capability: "tasks" }, fn), {
      message: 'MCP server "fx" does not advertise io.modelcontextprotocol/tasks.',
    });
    assert.equal(calls, 0);

    // needs-auth transport errors thrown by fn are normalized; other errors pass through.
    await assert.rejects(
      session.withServer({ server: "fx" }, async () => {
        throw new McpTransportError("needs-auth", "401 from server", 401);
      }),
      { message: 'MCP server "fx" requires sign-in; run /mcp login fx' },
    );
    await assert.rejects(
      session.withServer({ server: "fx" }, async () => {
        throw new Error("boom");
      }),
      { message: "boom" },
    );

    // The child spawned for resources/list is alive; removing the server reaps it.
    const pid = Number(readFileSync(h.pidFile, "utf8").trim());
    assert.ok(pid > 0 && isPidAlive(pid), "fixture child is running");
    h.writeConfig({ off: { enabled: false } });
    await session.reconcile(h.loadOptions());
    assert.equal(await waitForDeath(pid), true, "removed server child process was reaped");
    assert.deepEqual(
      (await session.servers()).map((s) => [s.name, s.era]),
      [["off", "disabled"]],
    );
    await assert.rejects(session.withServer({ server: "fx" }, fn), {
      message: 'Unknown MCP server "fx". Configured servers: off.',
    });
    assert.equal(calls, 0);

    // Shutdown is idempotent and aborts the session signal.
    const first = session.shutdown();
    const second = session.shutdown();
    await Promise.all([first, second]);
    await session.shutdown();
    assert.equal(session.signal.aborted, true);
    await assert.rejects(session.withServer({ server: "off" }, fn));
    assert.equal(calls, 0);
  } finally {
    await session?.shutdown();
    h.restoreEnv();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("createMcpSession: a slow first skills listing does not hold ready(), and the idle stdio server parks once it settles", async () => {
  const h = setup("session-skills-");
  let session: McpSession | undefined;
  try {
    h.writeConfig({ slow: { env: { FIXTURE_PID_FILE: h.pidFile, FIXTURE_SKILLS_DELAY_MS: "1500" } } });
    session = createMcpSession(h.pi, h.ctx);
    const started = Date.now();
    await session.reconcile(h.loadOptions());
    await session.ready();
    assert.ok(Date.now() - started < 1_000, "the first listing runs in the background");
    assert.deepEqual(
      session.skills.listed().map((l) => [l.server, l.skills.length]),
      [["slow", 0]],
    );
    const pid = Number(readFileSync(h.pidFile, "utf8").trim());
    for (let i = 0; i < 120 && session.skills.listed()[0]?.skills.length !== 1; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(session.skills.listed()[0]?.skills.length, 1);
    const [state] = await session.servers();
    assert.equal(
      session.skills.listed()[0].skills[0].frontmatter.description,
      state.instructions,
      "discovery and the first listing use the same process",
    );
    assert.equal(await waitForDeath(pid), true, "the idle stdio server parks after the listing");
  } finally {
    await session?.shutdown();
    h.restoreEnv();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("createMcpSession: restoreBranch restores pending tasks, holdsSettle tracks live clients, shutdown reaps children", async () => {
  const h = setup("session-seam-restore-");
  let session: McpSession | undefined;
  try {
    h.writeConfig({ fx: {} });
    session = createMcpSession(h.pi, h.ctx);
    const now = new Date().toISOString();
    const taskEntry = {
      type: "custom",
      customType: CUSTOM_TASKS,
      data: {
        server: "fx",
        taskId: "t-1",
        toolName: "slow",
        status: "working",
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: null,
        surfacedInputKeys: [],
        answeredInputKeys: [],
      },
    };
    session.restoreBranch([taskEntry], [taskEntry]);
    assert.deepEqual(
      session.tasks.active().map((t) => [t.server, t.taskId, t.status]),
      [["fx", "t-1", "working"]],
    );
    // No client for "fx" yet, so nothing can hold settlement.
    assert.equal(session.holdsSettle(), false);

    await session.reconcile(h.loadOptions());
    await session.servers();
    assert.equal(session.holdsSettle(), true, "pending task on a live modern server holds settle");

    // Spawn the child so shutdown has something to reap.
    await session.withServer({ server: "fx", capability: "resources" }, ({ logOpts }) =>
      session!.resources.list("fx", undefined, logOpts),
    );
    const pid = Number(readFileSync(h.pidFile, "utf8").trim());
    assert.ok(isPidAlive(pid));

    // Headless settle hold: a pending task holds; an aborted ctx releases without waking the agent.
    const abort = new AbortController();
    const holding = session.settle({ ...h.ctx, signal: abort.signal, hasPendingMessages: () => false } as typeof h.ctx);
    abort.abort();
    assert.equal(await holding, false);
    assert.equal(
      await session.settle({ ...h.ctx, signal: undefined, hasPendingMessages: () => true } as typeof h.ctx),
      false,
      "pending messages mean the agent is already continuing",
    );

    await session.shutdown(h.ctx);
    assert.equal(session.signal.aborted, true);
    assert.equal(session.holdsSettle(), false);
    assert.equal(await waitForDeath(pid), true, "shutdown closed the stdio child");
  } finally {
    await session?.shutdown();
    h.restoreEnv();
    rmSync(h.dir, { recursive: true, force: true });
  }
});
