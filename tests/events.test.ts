import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, createEventsEngine, formatEventDeliveries, subKeyOf } from "../src/events.ts";
import { CUSTOM_CURSORS, CUSTOM_SUBSCRIPTIONS } from "../src/types.ts";
import type {
  EngineHost,
  EventDelivery,
  JSONRPCNotification,
  JsonObject,
  ServerClient,
} from "../src/types.ts";

// ---- fakes ------------------------------------------------------------------------------

type Handler = (params: JsonObject, callIndex: number) => unknown;

class FakeStream {
  params: JsonObject;
  onNotification: (msg: JSONRPCNotification) => void;
  cancelled = false;
  resolveDone: (v: undefined) => void = () => {};
  rejectDone: (e: unknown) => void = () => {};
  done: Promise<undefined>;
  constructor(params: JsonObject, onNotification: (msg: JSONRPCNotification) => void) {
    this.params = params;
    this.onNotification = onNotification;
    this.done = new Promise((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
  }
  emit(method: string, params: JsonObject = {}): void {
    this.onNotification({ jsonrpc: "2.0", method, params });
  }
  end(): void { this.resolveDone(undefined); }
  fail(err: unknown): void { this.rejectDone(err); }
}

class FakeClient {
  name: string;
  state: Record<string, unknown>;
  calls: Array<{ method: string; params: JsonObject }> = [];
  streams: FakeStream[] = [];
  listenInterests: Array<{ owner: string; filter: unknown }> = [];
  listenListeners: Array<(msg: JSONRPCNotification) => void> = [];
  handlers = new Map<string, Handler>();
  constructor(name: string, delivery: string[], opts?: { eventsListChanged?: boolean }) {
    this.name = name;
    this.state = {
      name, transport: "http", era: "modern", events: true,
      eventsListChanged: opts?.eventsListChanged ?? false, tasks: false,
    };
    this.handlers.set("events/list", () => ({
      resultType: "complete",
      events: [{ name: "thing.happened", delivery }],
    }));
  }
  asClient(): ServerClient {
    const self = this;
    return {
      name: self.name,
      config: {} as never,
      state: self.state as never,
      discover: async () => self.state as never,
      request: async (method: string, params: JsonObject = {}) => {
        const idx = self.calls.filter(c => c.method === method).length;
        self.calls.push({ method, params });
        const handler = self.handlers.get(method);
        if (!handler) throw new Error(`no handler for ${method}`);
        return handler(params, idx);
      },
      openStream: async (_method: string, params: JsonObject, onNotification: (m: JSONRPCNotification) => void) => {
        const stream = new FakeStream(params, onNotification);
        self.calls.push({ method: "events/stream", params });
        self.streams.push(stream);
        return {
          requestId: `s${self.streams.length}`,
          done: stream.done,
          cancel: async () => { stream.cancelled = true; stream.resolveDone(undefined); },
        };
      },
      setListenInterest: (owner: string, filter: unknown) => { self.listenInterests.push({ owner, filter }); },
      onListenNotification: (listener: (m: JSONRPCNotification) => void) => {
        self.listenListeners.push(listener);
        return () => {};
      },
      onListenState: () => () => {},
      close: async () => {},
    } as unknown as ServerClient;
  }
  callsOf(method: string): Array<{ method: string; params: JsonObject }> {
    return this.calls.filter(c => c.method === method);
  }
}

function fakeHost(clients: Map<string, FakeClient>) {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const wakes: Array<{ customType: string; content: string; details: { deliveries: EventDelivery[] } }> = [];
  const host = {
    getClient: (server: string) => clients.get(server)?.asClient(),
    appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); },
    wake: (customType: string, content: string, details: { deliveries: EventDelivery[] }) => {
      wakes.push({ customType, content, details });
    },
    log: () => {},
    signal: new AbortController().signal,
  } as unknown as EngineHost;
  return { host, entries, wakes };
}

function occ(eventId: string, cursor?: string): JsonObject {
  return {
    eventId, name: "thing.happened", timestamp: "2026-07-28T00:00:00Z",
    data: { id: eventId }, ...(cursor !== undefined ? { cursor } : {}),
  };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (cond()) return; await sleep(5); }
  throw new Error(`timed out waiting for ${what}`);
}
const OPTS = { pollFloorMs: 5, batchWindowMs: 15, watchdogMs: 10_000, checkpointMs: 5 };

// ---- tests -------------------------------------------------------------------------------

test("helpers: canonicalJson sorts keys; subKeyOf frames identity; format escapes attributes", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(subKeyOf("s", "n", { b: 1, a: 2 }), 's\0n\0{"a":2,"b":1}');
  const out = formatEventDeliveries([{
    server: 'a"b', subKey: "k", name: "thing.happened", truncated: true,
    occurrences: [{ eventId: "e<1", name: "thing.happened", timestamp: "t", data: { x: 1 } }],
  }]);
  assert.match(out, /mcp_event_gap/);
  assert.match(out, /server="a&quot;b"/);
  assert.match(out, /event_id="e&lt;1"/);
  assert.match(out, /truncated="true"/);
});

test("poll drain of hasMore pages completes before the push stream opens", async t => {
  const client = new FakeClient("srv", ["poll", "push"]);
  client.handlers.set("events/poll", (_p, i) =>
    i === 0
      ? { resultType: "complete", events: [occ("e1")], cursor: "c1", hasMore: true }
      : { resultType: "complete", events: [occ("e2")], cursor: "c2", hasMore: false });
  const { host, wakes } = fakeHost(new Map([["srv", client]]));
  const engine = createEventsEngine(host, OPTS);
  t.after(() => engine.shutdown());

  await engine.subscribe({ server: "srv", name: "thing.happened", cursor: "c0" });
  const order = client.calls.filter(c => c.method !== "events/list").map(c => c.method);
  assert.deepEqual(order, ["events/poll", "events/poll", "events/stream"]);
  assert.equal(client.callsOf("events/poll")[0].params.cursor, "c0");
  assert.equal(client.callsOf("events/poll")[0].params.maxEvents, 100);
  assert.equal(client.callsOf("events/poll")[1].params.cursor, "c1");
  assert.equal(client.streams[0].params.cursor, "c2");
  await waitFor(() => wakes.length >= 1, "catch-up wake");
  assert.deepEqual(wakes[0].details.deliveries[0].occurrences.map(o => o.eventId), ["e1", "e2"]);
});

test("dedup: same eventId dropped on one subKey, delivered on two subKeys", async t => {
  const client = new FakeClient("srv", ["push"]);
  const { host, wakes } = fakeHost(new Map([["srv", client]]));
  const engine = createEventsEngine(host, OPTS);
  t.after(() => engine.shutdown());

  await engine.subscribe({ server: "srv", name: "thing.happened", arguments: { a: 1 } });
  await engine.subscribe({ server: "srv", name: "thing.happened", arguments: { a: 2 } });
  assert.equal(client.streams.length, 2);
  client.streams[0].emit("notifications/events/event", occ("dup", "c1"));
  client.streams[0].emit("notifications/events/event", occ("dup", "c1")); // duplicate, same subKey
  client.streams[1].emit("notifications/events/event", occ("dup", "c1")); // other subKey
  await waitFor(() => wakes.length >= 1, "dedup wake");
  const delivered = wakes.flatMap(w => w.details.deliveries.flatMap(d => d.occurrences));
  assert.equal(delivered.length, 2);
  assert.equal(new Set(wakes[0].details.deliveries.map(d => d.subKey)).size, 2);
});

test("cursor null is never persisted as non-null and is re-sent as null", async t => {
  const client = new FakeClient("srv", ["poll"]);
  client.handlers.set("events/poll", (_p, i) => ({
    resultType: "complete", events: i === 0 ? [occ("e1")] : [], hasMore: false, nextPollMs: 5,
    // cursor absent === null
  }));
  const { host, entries } = fakeHost(new Map([["srv", client]]));
  const engine = createEventsEngine(host, OPTS);
  t.after(() => engine.shutdown());

  await engine.subscribe({ server: "srv", name: "thing.happened" });
  await waitFor(() => client.callsOf("events/poll").length >= 3, "several polls");
  for (const call of client.callsOf("events/poll")) assert.equal(call.params.cursor, null);
  const cursorEntries = entries.filter(e => e.customType === CUSTOM_CURSORS);
  assert.ok(cursorEntries.length >= 1, "delivery persisted a cursor entry");
  for (const e of cursorEntries) assert.equal((e.data as { cursor: unknown }).cursor, null);
  assert.equal(engine.subscriptions()[0].cursor, null);
});

test("truncated active surfaces a gap and advances the cursor; heartbeat advances cursor", async t => {
  const client = new FakeClient("srv", ["push"]);
  const { host, wakes } = fakeHost(new Map([["srv", client]]));
  const engine = createEventsEngine(host, OPTS);
  t.after(() => engine.shutdown());

  await engine.subscribe({ server: "srv", name: "thing.happened" });
  client.streams[0].emit("notifications/events/active", { cursor: "c9", truncated: true });
  await waitFor(() => wakes.length >= 1, "gap wake");
  assert.match(wakes[0].content, /mcp_event_gap/);
  assert.match(wakes[0].content, /gap/);
  assert.equal(wakes[0].details.deliveries[0].truncated, true);
  assert.equal(engine.subscriptions()[0].cursor, "c9");

  client.streams[0].emit("notifications/events/heartbeat", { cursor: "hb1" });
  assert.equal(engine.subscriptions()[0].cursor, "hb1");
});

test("watchdog cancels a silent stream and reconnects with the latest cursor", async t => {
  const client = new FakeClient("srv", ["push"]);
  const { host } = fakeHost(new Map([["srv", client]]));
  const engine = createEventsEngine(host, { ...OPTS, watchdogMs: 40 });
  t.after(() => engine.shutdown());

  await engine.subscribe({ server: "srv", name: "thing.happened", cursor: "c0" });
  assert.equal(client.streams.length, 1);
  client.streams[0].emit("notifications/events/heartbeat", { cursor: "hb7" });
  await waitFor(() => client.streams.length >= 2, "watchdog reconnect");
  assert.equal(client.streams[0].cancelled, true);
  assert.equal(client.streams[1].params.cursor, "hb7");
});

test("deliveries within the batch window coalesce into one wake", async t => {
  const client = new FakeClient("srv", ["push"]);
  const { host, wakes } = fakeHost(new Map([["srv", client]]));
  const engine = createEventsEngine(host, OPTS);
  t.after(() => engine.shutdown());
  let wakeCount = 0;
  engine.onWake(() => { wakeCount++; });

  await engine.subscribe({ server: "srv", name: "thing.happened" });
  client.streams[0].emit("notifications/events/event", occ("e1", "c1"));
  client.streams[0].emit("notifications/events/event", occ("e2", "c2"));
  client.streams[0].emit("notifications/events/event", occ("e3", "c3"));
  await waitFor(() => wakes.length >= 1, "batched wake");
  await sleep(40);
  assert.equal(wakes.length, 1);
  assert.equal(wakeCount, 1);
  assert.deepEqual(wakes[0].details.deliveries[0].occurrences.map(o => o.eventId), ["e1", "e2", "e3"]);
  assert.equal((wakes[0].content.match(/<mcp_event /g) ?? []).length, 3);
});

test("re-subscribe of an active subKey is idempotent and does not reopen the stream", async t => {
  const client = new FakeClient("srv", ["push"]);
  const { host, entries } = fakeHost(new Map([["srv", client]]));
  const engine = createEventsEngine(host, OPTS);
  t.after(() => engine.shutdown());

  const first = await engine.subscribe({ server: "srv", name: "thing.happened", arguments: { x: 1 } });
  const again = await engine.subscribe({ server: "srv", name: "thing.happened", arguments: { x: 1 } });
  assert.equal(again.subKey, first.subKey);
  assert.equal(client.streams.length, 1);
  assert.equal(engine.activeStreams(), 1);
  assert.equal(entries.filter(e => e.customType === CUSTOM_SUBSCRIPTIONS).length, 1);
});
