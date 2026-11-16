import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createServerClient } from "../src/client.ts";
import { createEventsEngine } from "../src/events.ts";
import { CUSTOM_CURSORS, CUSTOM_SUBSCRIPTIONS, EXT_EVENTS, PROTOCOL_VERSION } from "../src/types.ts";
import type {
  CursorEntry,
  EngineHost,
  EventDelivery,
  EventsEngineApi,
  JsonObject,
  ServerClient,
  SubscriptionEntry,
} from "../src/types.ts";

type JournalEntry = {
  pid: number;
  method: string;
  id?: string | number;
  requestId?: string | number;
  params?: JsonObject;
  reason?: string;
  streamCount?: number;
};
type RecordedEntry = { customType: string; data: unknown };
type RecordedWake = { content: string; details: { deliveries?: EventDelivery[] } };
type Running = {
  client: ServerClient;
  engine: EventsEngineApi;
  entries: RecordedEntry[];
  wakes: RecordedWake[];
  journal(): JournalEntry[];
  calls(method: string): JournalEntry[];
  adopt(engine: EventsEngineApi): void;
  close(): Promise<void>;
};

const fixture = fileURLToPath(new URL("./fixtures/events-server.mjs", import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function start(t: TestContext, mode: string, watchdogMs = 5_000): Promise<Running> {
  const directory = mkdtempSync(join(tmpdir(), "mcp-events-suite4-"));
  const logPath = join(directory, "journal.jsonl");
  const client = createServerClient({
    name: "events",
    namespace: "mcp__events",
    scope: "global",
    enabled: true,
    timeoutMs: 2_000,
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    env: { EVENTS_SERVER_MODE: mode, EVENTS_SERVER_LOG: logPath },
  }, { cwd: process.cwd() });
  const entries: RecordedEntry[] = [];
  const wakes: RecordedWake[] = [];
  const host: EngineHost = {
    getClient: server => server === "events" ? client : undefined,
    appendEntry: (customType, data) => { entries.push({ customType, data }); },
    wake: (_customType, content, details) => {
      wakes.push({ content, details: details as { deliveries?: EventDelivery[] } });
    },
    log: () => {},
    signal: new AbortController().signal,
  };
  const engine = createEventsEngine(host, {
    pollFloorMs: 5,
    batchWindowMs: 10,
    watchdogMs,
    checkpointMs: 5,
  });
  const journal = (): JournalEntry[] => existsSync(logPath)
    ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as JournalEntry)
    : [];
  const engines = [engine];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    await Promise.all(engines.map(item => item.shutdown()));
    await client.close();
    const pid = journal()[0]?.pid;
    assert.ok(pid, "the stdio fixture recorded its pid");
    await waitFor(() => !processAlive(pid), "stdio child to be reaped after client.close()");
    closed = true;
  };
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });

  const state = await client.discover();
  assert.equal(state.era, "modern");
  assert.equal(state.events, true);
  assert.equal(state.eventsListChanged, true);
  assert.deepEqual(state.supportedVersions, [PROTOCOL_VERSION]);
  assert.equal(journal()[0].method, "server/discover");
  const discovered = await client.request<JsonObject>("server/discover");
  const capabilities = discovered.capabilities as JsonObject;
  assert.deepEqual((capabilities.extensions as JsonObject)[EXT_EVENTS], { listChanged: true });

  return {
    client,
    engine,
    entries,
    wakes,
    journal,
    calls: method => journal().filter(entry => entry.method === method),
    adopt: item => { engines.push(item); },
    close,
  };
}

function delivered(wakes: RecordedWake[]): EventDelivery[] {
  return wakes.flatMap(wake => wake.details.deliveries ?? []);
}

function cursorEntries(running: Running): CursorEntry[] {
  return running.entries
    .filter(entry => entry.customType === CUSTOM_CURSORS)
    .map(entry => entry.data as CursorEntry);
}

test("suite 4: poll catch-up drains every page before push activation", async t => {
  const running = await start(t, "catchup");
  const request = { server: "events", name: "thing.happened", cursor: "persisted-0" } as const;
  await running.engine.subscribe(request);

  await waitFor(() => running.calls("events/stream").length === 1, "push stream");
  const polls = running.calls("events/poll");
  assert.deepEqual(polls.map(call => call.params?.cursor), ["persisted-0", "persisted-1"]);
  assert.ok(polls.every(call => call.params?.maxEvents === 100));
  const handoff = running.journal().filter(entry => ["events/poll", "events/stream"].includes(entry.method));
  assert.deepEqual(handoff.map(entry => entry.method), ["events/poll", "events/poll", "events/stream"]);
  assert.equal(running.calls("events/stream")[0].params?.cursor, "persisted-2");
  await waitFor(() => delivered(running.wakes).some(delivery => delivery.occurrences.length === 2), "catch-up wake");
  assert.deepEqual(
    delivered(running.wakes)[0].occurrences.map(occurrence => occurrence.eventId),
    ["catchup-1", "catchup-2"],
  );

  assert.ok(running.calls("subscriptions/listen").length >= 1, "listChanged opens subscriptions/listen");

  await running.close();
  assert.equal(processAlive(running.journal()[0].pid), false);
});

test("suite 4: eventId dedup is per subKey, not global across argument subscriptions", async t => {
  const running = await start(t, "dedup");
  const declaration = { server: "events", name: "thing.happened", arguments: { channel: "one" } } as const;
  await running.engine.subscribe(declaration);
  await waitFor(() => running.calls("events/stream").length === 1, "first declarative stream");
  await running.engine.subscribe(declaration);
  assert.equal(running.calls("events/stream").length, 1, "declarative subscribe must be idempotent");
  await running.engine.subscribe({ server: "events", name: "thing.happened", arguments: { channel: "two" } });
  await waitFor(() => delivered(running.wakes).length === 2, "one delivery for each subscription");

  const batches = delivered(running.wakes);
  assert.equal(batches.length, 2);
  assert.ok(batches.every(batch => batch.occurrences.length === 1));
  assert.deepEqual(batches.map(batch => batch.occurrences[0].eventId), ["shared-event", "shared-event"]);
  assert.equal(new Set(batches.map(batch => batch.subKey)).size, 2);
  assert.equal(running.engine.subscriptions().length, 2);
});

test("suite 4: null cursors stay null; truncated activation advances and reports a gap", async t => {
  const running = await start(t, "edge");
  await running.engine.subscribe({ server: "events", name: "null.event", delivery: "poll" });
  await waitFor(() => running.calls("events/poll").length >= 3, "repeated null-cursor polls");
  assert.ok(running.calls("events/poll").every(call => call.params?.cursor === null));
  assert.equal(running.engine.subscriptions().find(sub => sub.name === "null.event")?.cursor, null);
  assert.ok(cursorEntries(running).length >= 1);
  assert.ok(cursorEntries(running).every(entry => entry.cursor === null));

  await running.engine.subscribe({ server: "events", name: "truncated.event" });
  await waitFor(() => running.wakes.some(wake => wake.content.includes("<mcp_event_gap")), "truncated gap wake");
  const truncated = running.wakes.find(wake => wake.content.includes("<mcp_event_gap"));
  assert.match(truncated?.content ?? "", /gap: events before this point may have been missed/);
  assert.equal(running.engine.subscriptions().find(sub => sub.name === "truncated.event")?.cursor, "truncated-1");
  assert.ok(cursorEntries(running).some(entry => entry.subKey.includes("truncated.event") && entry.cursor === "truncated-1"));
});

test("suite 4: heartbeat advances the cursor and a silent stream reconnects from it", async t => {
  const running = await start(t, "heartbeat", 45);
  await running.engine.subscribe({ server: "events", name: "thing.happened" });
  await waitFor(() => running.calls("events/stream").length === 1, "first push stream");
  await waitFor(() => running.engine.subscriptions()[0]?.cursor === "heartbeat-1", "heartbeat cursor");
  await waitFor(() => running.calls("events/stream").length >= 2, "watchdog reconnect");

  const streams = running.calls("events/stream");
  assert.equal(streams[0].params?.cursor, null);
  assert.equal(streams[1].params?.cursor, "heartbeat-1");
  const firstId = streams[0].id;
  assert.ok(running.journal().some(entry =>
    entry.method === "notifications/cancelled" && entry.requestId === firstId && entry.reason === "watchdog"
  ));
  assert.equal(running.engine.subscriptions()[0].cursor, "heartbeat-1");
});

test("suite 4: restore resumes persisted state without replaying delivered eventIds", async t => {
  const running = await start(t, "resume");
  await running.engine.subscribe({ server: "events", name: "thing.happened" });
  await waitFor(() => delivered(running.wakes).flatMap(batch => batch.occurrences).length === 1, "initial push event");
  assert.equal(running.engine.subscriptions()[0].cursor, "resume-1");
  await running.engine.shutdown();

  const restoredWakes: RecordedWake[] = [];
  const restoredHost: EngineHost = {
    getClient: () => running.client,
    appendEntry: (customType, data) => { running.entries.push({ customType, data }); },
    wake: (_customType, content, details) => {
      restoredWakes.push({ content, details: details as { deliveries?: EventDelivery[] } });
    },
    log: () => {},
    signal: new AbortController().signal,
  };
  const restored = createEventsEngine(restoredHost, {
    pollFloorMs: 5,
    batchWindowMs: 10,
    watchdogMs: 5_000,
    checkpointMs: 5,
  });
  running.adopt(restored);
  const branch = running.entries.filter(entry => entry.customType === CUSTOM_SUBSCRIPTIONS)
    .map(entry => ({ customType: entry.customType, data: entry.data as SubscriptionEntry }));
  restored.restore(branch, running.entries);

  await waitFor(() => running.calls("events/stream").length === 2, "restored push stream");
  await waitFor(() => delivered(restoredWakes).flatMap(batch => batch.occurrences).length === 1, "restored catch-up wake");
  const resumePoll = running.calls("events/poll").find(call => call.params?.cursor === "resume-1");
  assert.ok(resumePoll, "restore polls from the persisted cursor");
  assert.equal(running.calls("events/stream")[1].params?.cursor, "resume-2");
  const replayed = delivered(restoredWakes).flatMap(batch => batch.occurrences);
  assert.deepEqual(replayed.map(occurrence => occurrence.eventId), ["resume-2"]);
  assert.equal(replayed.some(occurrence => occurrence.eventId === "resume-1"), false);
});
