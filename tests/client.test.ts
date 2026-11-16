import assert from "node:assert/strict";
import test from "node:test";
import { buildMeta, createServerClient } from "../src/client.ts";
import { EXT_EVENTS, EXT_TASKS, META_PROTOCOL_VERSION, META_SUBSCRIPTION_ID, PROTOCOL_VERSION } from "../src/types.ts";
import type {
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCResultResponse,
  JsonObject,
  Mcp2026Transport,
  OpenStreamHandle,
  ResolvedServer,
  TransportRequestOptions,
} from "../src/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type FakeStream = {
  msg: JSONRPCRequest;
  handle: OpenStreamHandle;
  emit(msg: JSONRPCNotification): void;
  finish(result?: JsonObject): void;
  fail(error: unknown): void;
};

class FakeTransport implements Mcp2026Transport {
  readonly kind: "stdio" | "http";
  readonly requests: Array<{ msg: JSONRPCRequest; opts?: TransportRequestOptions }> = [];
  readonly streams: FakeStream[] = [];
  readonly events: string[] = [];
  closeCount = 0;
  requestHandler?: (msg: JSONRPCRequest, opts?: TransportRequestOptions) => Promise<JSONRPCResponse>;
  private closeListeners = new Set<(err?: Error) => void>();
  private streamWaiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(kind: "stdio" | "http" = "stdio") {
    this.kind = kind;
  }

  async request(msg: JSONRPCRequest, opts?: TransportRequestOptions): Promise<JSONRPCResponse> {
    this.requests.push({ msg, opts });
    return this.requestHandler?.(msg, opts) ?? { jsonrpc: "2.0", id: msg.id, result: {} };
  }

  async openStream(
    msg: JSONRPCRequest,
    onNotification: (msg: JSONRPCNotification) => void,
  ): Promise<OpenStreamHandle> {
    const done = deferred<JSONRPCResultResponse | undefined>();
    const stream: FakeStream = {
      msg,
      handle: {
        requestId: msg.id,
        done: done.promise,
        cancel: async () => {
          this.events.push(`cancel:${String(msg.id)}`);
          done.resolve(undefined);
        },
      },
      emit: onNotification,
      finish(result) {
        done.resolve(result === undefined ? undefined : { jsonrpc: "2.0", id: msg.id, result });
      },
      fail: done.reject,
    };
    this.streams.push(stream);
    this.events.push(`open:${String(msg.id)}`);
    for (const waiter of [...this.streamWaiters]) {
      if (this.streams.length >= waiter.count) {
        waiter.resolve();
        this.streamWaiters.splice(this.streamWaiters.indexOf(waiter), 1);
      }
    }
    return stream.handle;
  }

  onUnexpectedClose(listener: (err?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  unexpectedClose(): void {
    for (const listener of [...this.closeListeners]) listener(new Error("dropped"));
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  waitForStream(count: number): Promise<void> {
    if (this.streams.length >= count) return Promise.resolve();
    const wait = deferred<void>();
    this.streamWaiters.push({ count, resolve: wait.resolve });
    return wait.promise;
  }
}

function config(transport: "stdio" | "http" = "stdio"): ResolvedServer {
  const base = {
    name: "test",
    namespace: "mcp__test",
    scope: "global" as const,
    enabled: true,
    timeoutMs: 60_000,
  };
  return transport === "stdio"
    ? { ...base, transport, command: "server", args: [], env: {} }
    : { ...base, transport, url: "https://example.test/mcp", headers: {} };
}

function withFake(transport = new FakeTransport(), server: ResolvedServer = config()) {
  const client = createServerClient(server, {
    cwd: "/tmp",
    createTransport: async () => transport,
    backoff: { baseMs: 5, maxMs: 10 },
  });
  return { client, transport };
}

function result(id: string | number, value: JsonObject): JSONRPCResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function rpcError(id: string | number, code: number, data?: unknown): JSONRPCResponse {
  return { jsonrpc: "2.0", id, error: { code, message: "error", data } };
}

function ack(id: string | number, taskIds: string[] = [], eventsListChanged = false): JSONRPCNotification {
  return {
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: {
      _meta: { [META_SUBSCRIPTION_ID]: id },
      notifications: { ...(eventsListChanged ? { eventsListChanged: true } : {}), ...(taskIds.length ? { taskIds } : {}) },
    },
  };
}

function taskNotification(id: string | number): JSONRPCNotification {
  return {
    jsonrpc: "2.0",
    method: "notifications/tasks",
    params: { taskId: "task-1", _meta: { [META_SUBSCRIPTION_ID]: id } },
  };
}

test("buildMeta advertises extensions and optional fulfillment capabilities", () => {
  const meta = buildMeta({ roots: true, elicitation: true });
  assert.equal(meta[META_PROTOCOL_VERSION], PROTOCOL_VERSION);
  const capabilities = meta["io.modelcontextprotocol/clientCapabilities"] as JsonObject;
  assert.deepEqual(capabilities.extensions, { [EXT_EVENTS]: {}, [EXT_TASKS]: {} });
  assert.deepEqual(capabilities.roots, {});
  assert.deepEqual(capabilities.elicitation, { form: {}, url: {} });
});

test("connects lazily, merges _meta into every request, and allocates unique ids", async () => {
  const transport = new FakeTransport();
  let creations = 0;
  const client = createServerClient(config(), {
    cwd: "/tmp",
    createTransport: async () => { creations += 1; return transport; },
  });
  assert.equal(creations, 0);
  await client.request("events/list", { cursor: "c", _meta: { kept: true } });
  await client.request("tasks/get", { taskId: "t" });
  assert.equal(creations, 1);
  assert.equal(transport.requests[0].msg.params?._meta?.kept, true);
  for (const request of transport.requests) {
    assert.equal(request.msg.params?._meta?.[META_PROTOCOL_VERSION], PROTOCOL_VERSION);
  }
  assert.notEqual(transport.requests[0].msg.id, transport.requests[1].msg.id);
  assert.equal(transport.requests[1].opts?.timeoutMs, 60_000);
  await client.close();
});

test("discover records a modern server and its extension capabilities", async () => {
  const transport = new FakeTransport("http");
  transport.requestHandler = async msg => result(msg.id, {
    resultType: "complete",
    supportedVersions: [PROTOCOL_VERSION],
    capabilities: { extensions: { [EXT_EVENTS]: { listChanged: true }, [EXT_TASKS]: {} } },
    instructions: "Use the tasks",
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "server", version: "1" } },
  });
  const { client } = withFake(transport, config("http"));
  const state = await client.discover();
  assert.equal(state.era, "modern");
  assert.equal(state.events, true);
  assert.equal(state.eventsListChanged, true);
  assert.equal(state.tasks, true);
  assert.deepEqual(state.serverInfo, { name: "server", version: "1" });
  assert.equal(state.instructions, "Use the tasks");
  assert.equal(transport.requests[0].msg.method, "server/discover");
  assert.equal(transport.requests[0].opts?.timeoutMs, 10_000);
  assert.equal(transport.closeCount, 0);
  await client.close();
});

test("discover closes a modern-dormant probe", async () => {
  const transport = new FakeTransport();
  transport.requestHandler = async msg => result(msg.id, {
    resultType: "complete",
    supportedVersions: [PROTOCOL_VERSION],
    capabilities: {},
  });
  const { client } = withFake(transport);
  assert.equal((await client.discover()).era, "modern-dormant");
  assert.equal(transport.closeCount, 1);
  await client.close();
});

for (const supportsCurrent of [true, false]) {
  test(`discover handles -32022 ${supportsCurrent ? "with" : "without"} ${PROTOCOL_VERSION}`, async () => {
    const transport = new FakeTransport();
    const supportedVersions = supportsCurrent ? [PROTOCOL_VERSION] : ["2025-11-25"];
    transport.requestHandler = async msg => rpcError(msg.id, -32022, { supported: supportedVersions });
    const { client } = withFake(transport);
    const state = await client.discover();
    assert.equal(state.era, supportsCurrent ? "modern" : "unsupported-modern-version");
    assert.deepEqual(state.supportedVersions, supportedVersions);
    assert.equal(transport.closeCount, supportsCurrent ? 0 : 1);
    await client.close();
  });
}

test("a legacy JSON-RPC error closes the probe without logging an error", async () => {
  const transport = new FakeTransport();
  transport.requestHandler = async msg => rpcError(msg.id, -32601);
  const logs: string[] = [];
  const client = createServerClient(config(), {
    cwd: "/tmp",
    createTransport: async () => transport,
    log: level => { if (level === "error") logs.push(level); },
  });
  assert.equal((await client.discover()).era, "legacy");
  assert.equal(transport.closeCount, 1);
  assert.equal(transport.requests.length, 1);
  assert.notEqual(transport.requests[0].msg.method, "initialize");
  assert.deepEqual(logs, []);
  await client.close();
});

test("listen discards pre-ack frames and delivers only post-ack notifications", async () => {
  const { client, transport } = withFake();
  const states: unknown[] = [];
  const notifications: JSONRPCNotification[] = [];
  client.onListenState(honored => { states.push(honored); });
  client.onListenNotification(msg => { notifications.push(msg); });
  client.setListenInterest("events", { eventsListChanged: false, taskIds: [] });
  client.setListenInterest("tasks", { taskIds: ["task-1"] });
  await transport.waitForStream(1);
  const stream = transport.streams[0];
  assert.deepEqual(stream.msg.params?.notifications, { taskIds: ["task-1"] });
  stream.emit(taskNotification(stream.msg.id));
  assert.equal(notifications.length, 0);
  stream.emit(ack(stream.msg.id, ["task-1"]));
  assert.deepEqual(states, [{ taskIds: ["task-1"] }]);
  stream.emit(taskNotification(stream.msg.id));
  assert.equal(notifications.length, 1);
  await client.close();
});

test("listen replacement acknowledges the new stream before cancelling the old", async () => {
  const { client, transport } = withFake();
  client.onListenState(honored => {
    if (honored) transport.events.push(`ack:${String(honored.taskIds?.at(-1))}`);
  });
  client.setListenInterest("tasks", { taskIds: ["old"] });
  await transport.waitForStream(1);
  const old = transport.streams[0];
  old.emit(ack(old.msg.id, ["old"]));
  client.setListenInterest("tasks", { taskIds: ["old", "new"] });
  await transport.waitForStream(2);
  const replacement = transport.streams[1];
  assert.deepEqual(replacement.msg.params?.notifications, { taskIds: ["old", "new"] });
  assert.equal(transport.events.some(event => event === `cancel:${String(old.msg.id)}`), false);
  replacement.emit(ack(replacement.msg.id, ["old", "new"]));
  assert.deepEqual(transport.events.slice(-2), [`ack:new`, `cancel:${String(old.msg.id)}`]);
  await client.close();
});

test("an empty union cancels the listen stream immediately", async () => {
  const { client, transport } = withFake();
  const states: unknown[] = [];
  client.onListenState(honored => { states.push(honored); });
  client.setListenInterest("tasks", { taskIds: ["task-1"] });
  await transport.waitForStream(1);
  const stream = transport.streams[0];
  stream.emit(ack(stream.msg.id, ["task-1"]));
  client.setListenInterest("tasks", { taskIds: [] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(transport.events.at(-1), `cancel:${String(stream.msg.id)}`);
  assert.deepEqual(states, [{ taskIds: ["task-1"] }, undefined]);
  assert.equal(transport.streams.length, 1);
  await client.close();
});

test("an unexpected listen drop reconnects with a fresh id", async () => {
  const { client, transport } = withFake();
  const states: unknown[] = [];
  client.onListenState(honored => { states.push(honored); });
  client.setListenInterest("tasks", { taskIds: ["task-1"] });
  await transport.waitForStream(1);
  const first = transport.streams[0];
  first.emit(ack(first.msg.id, ["task-1"]));
  first.finish();
  await transport.waitForStream(2);
  const second = transport.streams[1];
  assert.notEqual(second.msg.id, first.msg.id);
  assert.deepEqual(second.msg.params?.notifications, { taskIds: ["task-1"] });
  assert.deepEqual(states, [{ taskIds: ["task-1"] }, undefined]);
  second.emit(ack(second.msg.id, ["task-1"]));
  await client.close();
});
