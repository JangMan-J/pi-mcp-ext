import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServerClient } from "../src/client.ts";
import type { JsonObject, ResolvedServer } from "../src/types.ts";
// @ts-ignore JavaScript fixture
import { startHttpServer } from "./fixtures/http-server.mjs";

const base = { name: "MCP", namespace: "mcp__MCP", scope: "session" as const, enabled: true, timeoutMs: 700 };
const complete = { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: {
  extensions: { "io.modelcontextprotocol/events": { listChanged: true }, "io.modelcontextprotocol/tasks": {} },
} };
const cases = [
  { label: "unsupported version", reply: { error: { code: -32022, message: "UnsupportedProtocolVersion", data: { supported: ["2025-11-25"] } } }, era: "unsupported-modern-version" },
  ...[-32020, -32021].map(code => ({ label: String(code), reply: { error: { code, message: "Modern MCP error" } }, era: "modern" })),
  { label: "extensions", reply: { result: complete }, era: "modern" },
  { label: "dormant", reply: { result: { ...complete, capabilities: {} } }, era: "modern-dormant" },
];

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

async function stdioProbe(mode: string, reply?: JsonObject, era = "legacy") {
  const dir = mkdtempSync(join(tmpdir(), "mcp-discovery-"));
  const recordPath = join(dir, "record.json");
  const logs: string[] = [];
  const config: ResolvedServer = { ...base, transport: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL(reply ? "./fixtures/modern-stdio-server.mjs" : "./fixtures/legacy-stdio-server.mjs", import.meta.url))],
    env: { MCP_RECORD: recordPath, MCP_MODE: mode, MCP_REPLY: JSON.stringify(reply ?? {}) } };
  const client = createServerClient(config, { cwd: process.cwd(), log: level => logs.push(level) });
  try {
    const state = await client.discover();
    assert.equal(state.era, era);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.initialize, false);
    assert.deepEqual(record.methods.filter((method: string) => method !== "notifications/cancelled"),
      mode === "eof" ? [] : ["server/discover"]);
    assert.deepEqual(logs.filter(level => level === "error" || level === "warn"), []);
    if (era !== "modern") {
      const deadline = Date.now() + 3500;
      while (alive(record.pid) && Date.now() < deadline) await delay(10);
      assert.equal(alive(record.pid), false, "probe child must be reaped before client.close()");
    }
    if (reply?.result === complete) {
      assert.equal(state.events, true);
      assert.equal(state.tasks, true);
      assert.equal(state.eventsListChanged, true);
    }
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
}

for (const mode of ["legacy", "timeout", "eof"]) {
  test("stdio legacy fallback: " + mode, () => stdioProbe(mode));
}
for (const entry of cases) {
  test("stdio modern discovery: " + entry.label, () => stdioProbe("modern", entry.reply, entry.era));
}

const httpCases = [
  ...[404, 405, 400].map(status => ({ label: String(status), status, body: status === 400 ? "not JSON" : "", era: "legacy" })),
  { label: "method not found", reply: { error: { code: -32601, message: "Method not found" } }, era: "legacy" },
  ...cases,
];
for (const entry of httpCases) {
  test("HTTP discovery: " + entry.label, async () => {
    const logs: string[] = [];
    const server = await startHttpServer((request: any, response: any) => {
      if ("status" in entry) { response.writeHead(entry.status); response.end(entry.body); return; }
      return { jsonrpc: "2.0", id: request.body.id, ...entry.reply };
    });
    const client = createServerClient({ ...base, transport: "http", url: server.url, headers: {} },
      { cwd: process.cwd(), log: level => logs.push(level) });
    try {
      const state = await client.discover();
      assert.equal(state.era, entry.era);
      assert.deepEqual(logs.filter(level => level === "error" || level === "warn"), []);
      if ("reply" in entry && "result" in entry.reply && entry.reply.result === complete) {
        assert.equal(state.events, true);
        assert.equal(state.tasks, true);
        assert.equal(state.eventsListChanged, true);
      }
      await client.close();
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0].method, "POST");
      assert.equal(server.requests[0].body.method, "server/discover");
    } finally { await client.close(); await server.close(); }
  });
}
