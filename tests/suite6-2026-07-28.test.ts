import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import { createServerClient } from "../src/client.ts";
import { createEventsEngine } from "../src/events.ts";
import { createTasksEngine } from "../src/tasks.ts";
import {
  META_LOG_LEVEL,
  type EngineHost,
  type JSONRPCRequest,
  type Mcp2026Transport,
  type ResolvedHttpServer,
} from "../src/types.ts";

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

test("SEP-2575: request logLevel attaches _meta and subscriptions/listen unions all filter keys", async () => {
  const sent: JSONRPCRequest[] = [];
  const transport: Mcp2026Transport = {
    kind: "stdio",
    async request(msg) {
      sent.push(msg);
      return { jsonrpc: "2.0", id: msg.id, result: { resultType: "complete" } };
    },
    async openStream(msg) {
      sent.push(msg);
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
  });

  await client.request("tools/call", { name: "ping" }, { logLevel: "warning" });
  assert.equal(sent[0].params?._meta?.[META_LOG_LEVEL], "warning");

  client.setListenInterest("events", { eventsListChanged: true, toolsListChanged: true });
  client.setListenInterest("tasks", {
    taskIds: ["t-1"],
    resourcesListChanged: true,
    resourceSubscriptions: ["file:///a"],
  });
  await new Promise((r) => setTimeout(r, 10));

  const listen = sent.find((m) => m.method === "subscriptions/listen");
  assert.ok(listen);
  assert.deepEqual(listen.params?.notifications, {
    eventsListChanged: true,
    toolsListChanged: true,
    resourcesListChanged: true,
    resourceSubscriptions: ["file:///a"],
    taskIds: ["t-1"],
  });
  await client.close();
});

test("SEP-2322 MRTR: tools/call input_required retries with inputResponses and requestState", async () => {
  const seenCalls: Array<Record<string, unknown>> = [];
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
              capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
            },
          };
        }
        seenCalls.push((msg.params ?? {}) as Record<string, unknown>);
        if (!msg.params?.inputResponses) {
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              resultType: "input_required",
              requestState: "state-opaque-1",
              inputRequests: {
                user_name: {
                  method: "elicitation/create",
                  params: { mode: "form", message: "Name?" },
                },
              },
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            resultType: "complete",
            content: [{ type: "text", text: "ok" }],
          },
        };
      },
      async openStream(msg) {
        return { requestId: msg.id, cancel: async () => {}, done: Promise.resolve(undefined) };
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
  const tasks = createTasksEngine(host);

  const first = await tasks.call("spec-server", "auth_tool", { repo: "x" });
  assert.equal(first.resultType, "input_required");

  const second = await tasks.call("spec-server", "auth_tool", { repo: "x" }, undefined, {
    inputResponses: { user_name: { action: "accept", content: { name: "ada" } } },
    requestState: "state-opaque-1",
  });
  assert.equal(second.resultType, "complete");
  assert.equal(seenCalls[1].requestState, "state-opaque-1");
  assert.deepEqual(seenCalls[1].inputResponses, {
    user_name: { action: "accept", content: { name: "ada" } },
  });

  await tasks.shutdown();
  await client.close();
});

test("SEP-2549: events/list ttlMs expires cached descriptors cleanly", async () => {
  let listCount = 0;
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
              capabilities: { extensions: { "io.modelcontextprotocol/events": { list: true, poll: true } } },
            },
          };
        }
        if (msg.method === "events/list") {
          listCount += 1;
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              resultType: "complete",
              ttlMs: 15,
              cacheScope: "private",
              events: [{ name: "ping", delivery: ["poll"] }],
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: { resultType: "complete", events: [], cursor: "0", hasMore: false },
        };
      },
      async openStream(msg) {
        return { requestId: msg.id, cancel: async () => {}, done: Promise.resolve(undefined) };
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
  const events = createEventsEngine(host, { pollFloorMs: 500 });
  await events.subscribe({ server: "spec-server", name: "ping", delivery: "poll" });
  const beforeExpiry = listCount;
  await new Promise((r) => setTimeout(r, 30));
  events.restore(
    [{ type: "custom", customType: "mcp-ext:subscriptions", data: { op: "upsert", subscription: { subKey: "k2", server: "spec-server", name: "ping", delivery: "poll", holdSettle: false } } }],
    [],
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(listCount > beforeExpiry, `expected ttlMs expiry to refetch events/list (${beforeExpiry} -> ${listCount})`);

  await events.shutdown();
  await client.close();
});

test("SEP-2127: discoverCard fetches /mcp/server-card metadata", async () => {
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/mcp/server-card") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "demo-card", version: "1.0.0", protocolVersions: ["2026-07-28"] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const addr = srv.address();
  assert.ok(addr && typeof addr === "object");

  const client = createServerClient(httpConfig(`http://127.0.0.1:${addr.port}/mcp`), {
    cwd: process.cwd(),
  });
  const card = await client.discoverCard?.();
  assert.equal(card?.name, "demo-card");
  assert.equal(client.state.serverCard?.version, "1.0.0");

  await client.close();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
});
