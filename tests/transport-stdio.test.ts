import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioTransport } from "../src/transport-stdio.ts";
import { isErrorResponse, McpRpcError, McpTransportError } from "../src/types.ts";
import type { JSONRPCNotification, ResolvedStdioServer } from "../src/types.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, "..");
const fixturePath = resolve(testDir, "fixtures/stdio-echo.mjs");

function makeServer(overrides?: Partial<ResolvedStdioServer>): ResolvedStdioServer {
  return {
    name: "echo",
    namespace: "mcp__echo",
    scope: "global",
    enabled: true,
    timeoutMs: 5_000,
    transport: "stdio",
    command: process.execPath,
    args: [fixturePath],
    env: {},
    ...overrides,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

test("request/response echoes JSON-RPC payloads, expands env via resolveValue, resolves cwd, and ignores stderr noise", async () => {
  let unexpectedFired = false;
  const transport = await createStdioTransport(
    makeServer({
      cwd: "tests",
      env: { MCP_TEST_ENV: "raw-token" },
    }),
    {
      cwd: rootDir,
      resolveValue: (v) => `resolved:${v}`,
    },
  );
  transport.onUnexpectedClose(() => {
    unexpectedFired = true;
  });

  try {
    const res = await transport.request({
      jsonrpc: "2.0",
      id: "req-1",
      method: "test/echo",
      params: { message: "line1\nline2\r\nline3", stderrNoise: "harmless warning on stderr" },
    });
    assert.equal(isErrorResponse(res), false);
    if (isErrorResponse(res)) throw new Error("unexpected error response");
    assert.deepEqual(res.result.echo, {
      method: "test/echo",
      params: { message: "line1\nline2\r\nline3", stderrNoise: "harmless warning on stderr" },
    });
    assert.equal(res.result.envValue, "resolved:raw-token");
    assert.equal(res.result.cwd, realpathSync(testDir));

    const errRes = await transport.request({
      jsonrpc: "2.0",
      id: "req-err",
      method: "test/rpc-error",
      params: { code: -32601, message: "No such method" },
    });
    assert.equal(isErrorResponse(errRes), true);
    if (!isErrorResponse(errRes)) throw new Error("expected JSON-RPC error response");
    assert.equal(errRes.error.code, -32601);
  } finally {
    await transport.close();
  }
  assert.equal(unexpectedFired, false);
});

test("openStream routes notifications strictly by subscriptionId, resolves final result, and rejects McpRpcError on error response", async () => {
  const transport = await createStdioTransport(makeServer(), { cwd: rootDir });
  try {
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];

    const holdA = await transport.openStream(
      {
        jsonrpc: "2.0",
        id: "sub-a",
        method: "test/stream",
        params: { items: ["a1"], holdOpen: true },
      },
      (notif) => {
        seenA.push(notif.params?.item);
      },
    );

    const streamB = await transport.openStream(
      {
        jsonrpc: "2.0",
        id: "sub-b",
        method: "test/stream",
        params: { items: ["b1", "b2"], emitUnmatched: true },
      },
      (notif) => {
        seenB.push(notif.params?.item);
      },
    );

    const finalB = await streamB.done;
    assert.deepEqual(finalB?.result, { resultType: "complete", count: 2 });
    assert.deepEqual(seenB, ["b1", "b2"]);
    assert.deepEqual(seenA, ["a1"]);

    await holdA.cancel("done-a");
    assert.equal(await holdA.done, undefined);

    const errStream = await transport.openStream(
      {
        jsonrpc: "2.0",
        id: "sub-err",
        method: "test/stream",
        params: { items: ["before-err"], error: { code: -32023, message: "Not found" } },
      },
      () => {},
    );
    await assert.rejects(
      errStream.done,
      (err: unknown) => err instanceof McpRpcError && err.code === -32023 && err.message === "Not found",
    );
  } finally {
    await transport.close();
  }
});

test("cancellation on timeout, AbortSignal, and stream.cancel sends notifications/cancelled without killing the server", async () => {
  const transport = await createStdioTransport(makeServer(), { cwd: rootDir });
  try {
    await transport.request({ jsonrpc: "2.0", id: "warm-cancel", method: "test/echo" });

    await assert.rejects(
      transport.request(
        { jsonrpc: "2.0", id: "hang-timeout", method: "test/hang" },
        { timeoutMs: 40 },
      ),
      (err: unknown) => err instanceof McpTransportError && err.kind === "timeout",
    );

    const controller = new AbortController();
    const pendingAbort = transport.request(
      { jsonrpc: "2.0", id: "hang-abort", method: "test/hang" },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort("user-cancelled"), 20);
    await assert.rejects(
      pendingAbort,
      (err: unknown) => err instanceof McpTransportError && err.kind === "aborted",
    );

    const stream = await transport.openStream(
      { jsonrpc: "2.0", id: "stream-cancel", method: "test/stream", params: { items: ["x"], holdOpen: true } },
      () => {},
    );
    await stream.cancel("no-longer-needed");
    assert.equal(await stream.done, undefined);

    // Server remains alive after all three cancellations and recorded each notifications/cancelled.
    const stateRes = await transport.request({
      jsonrpc: "2.0",
      id: "check-cancelled",
      method: "test/echo",
    });
    assert.equal(isErrorResponse(stateRes), false);
    if (isErrorResponse(stateRes)) throw new Error("unexpected error");
    const cancelled = stateRes.result.cancelled as Array<{ requestId: string; reason?: string }>;
    const ids = cancelled.map((c) => c.requestId);
    assert.deepEqual(ids, ["hang-timeout", "hang-abort", "stream-cancel"]);
    assert.equal(cancelled[1]?.reason, "user-cancelled");
    assert.equal(cancelled[2]?.reason, "no-longer-needed");

    await assert.rejects(
      transport.request({
        jsonrpc: "2.0",
        id: "crash-stderr-check",
        method: "test/crash",
        params: { code: 1 },
      }),
      (err: unknown) => {
        assert.ok(err instanceof McpTransportError);
        assert.equal(err.kind, "closed");
        assert.ok(err.message.includes('cancelled:{"requestId":"hang-timeout"'));
        assert.ok(err.message.includes('cancelled:{"requestId":"hang-abort","reason":"user-cancelled"}'));
        assert.ok(err.message.includes('cancelled:{"requestId":"stream-cancel","reason":"no-longer-needed"}'));
        return true;
      },
    );
  } finally {
    await transport.close();
  }
});

test("notifications/progress resets the pending request timeout and invokes onNotification", async () => {
  const transport = await createStdioTransport(makeServer(), { cwd: rootDir });
  try {
    await transport.request({ jsonrpc: "2.0", id: "warm-slow", method: "test/echo" });

    const progressEvents: JSONRPCNotification[] = [];
    const res = await transport.request(
      {
        jsonrpc: "2.0",
        id: "slow-1",
        method: "test/slow",
        params: {
          steps: 4,
          intervalMs: 75,
          _meta: { progressToken: "pt-slow-1" },
        },
      },
      {
        timeoutMs: 220,
        onNotification: (msg) => {
          progressEvents.push(msg);
        },
      },
    );
    assert.equal(isErrorResponse(res), false);
    if (isErrorResponse(res)) throw new Error("unexpected error");
    assert.deepEqual(res.result, { ok: true, steps: 4 });
    assert.equal(progressEvents.length, 4);
    assert.equal(progressEvents[0]?.params?.progressToken, "pt-slow-1");
  } finally {
    await transport.close();
  }
});

test("unexpected exit fires onUnexpectedClose, includes trailing 2000 chars of stderr, and resolves openStream.done as undefined", async () => {
  const transport = await createStdioTransport(makeServer(), { cwd: rootDir });
  let unexpectedErr: Error | undefined;
  transport.onUnexpectedClose((err) => {
    unexpectedErr = err;
  });

  const openHold = await transport.openStream(
    { jsonrpc: "2.0", id: "hold-1", method: "test/stream", params: { items: [], holdOpen: true } },
    () => {},
  );

  const longPrefix = "x".repeat(2500);
  const marker = "TAIL_DIAGNOSTIC_MARKER";
  await assert.rejects(
    transport.request({
      jsonrpc: "2.0",
      id: "crash-1",
      method: "test/crash",
      params: { stderr: `${longPrefix}${marker}`, code: 2 },
    }),
    (err: unknown) => {
      assert.ok(err instanceof McpTransportError);
      assert.equal(err.kind, "closed");
      assert.ok(err.message.includes(marker));
      assert.equal(err.message.includes("x".repeat(2100)), false);
      return true;
    },
  );

  assert.equal(await openHold.done, undefined);
  assert.ok(unexpectedErr instanceof McpTransportError);
  assert.ok(unexpectedErr.message.includes(marker));
  await transport.close();
});

test("close() is idempotent and reaps the child process group (pid no longer alive)", async () => {
  const transport = await createStdioTransport(
    makeServer({ args: [fixturePath, "--ignore-eof", "--spawn-subchild"] }),
    { cwd: rootDir },
  );

  const info = await transport.request({
    jsonrpc: "2.0",
    id: "pid-check",
    method: "test/echo",
  });
  assert.equal(isErrorResponse(info), false);
  if (isErrorResponse(info)) throw new Error("unexpected error");
  const pid = info.result.pid as number;
  const subchildPid = info.result.subchildPid as number | null;
  assert.equal(isPidAlive(pid), true);
  if (subchildPid !== null) {
    assert.equal(isPidAlive(subchildPid), true);
  }

  await Promise.all([transport.close(), transport.close()]);
  assert.equal(isPidAlive(pid), false);
  if (subchildPid !== null) {
    for (let i = 0; i < 40 && isPidAlive(subchildPid); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(isPidAlive(subchildPid), false);
  }
});
