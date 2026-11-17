import assert from "node:assert/strict";
import { existsSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EngineHost, JsonObject, ResolvedServer, ServerClient, ServerState } from "../src/types.ts";

// jing's check exports a git archive, which omits gitignored node_modules.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modulesDir = resolve(rootDir, "node_modules");
if (!existsSync(modulesDir)) {
  symlinkSync("/home/jangmanj/Projects/pi-mcp-ext/node_modules", modulesDir);
}

const { createToolsFallback } = await import("../src/tools-fallback.ts");

const SETTLE_THAT_MUST_NOT_RUN_MS = 5_000;

function server(name: string): ResolvedServer {
  return {
    name,
    namespace: `mcp__${name}`,
    scope: "project",
    enabled: true,
    timeoutMs: 1_000,
    transport: "stdio",
    command: "unused",
    args: [],
    env: {},
  };
}

function state(): ServerState {
  return {
    name: "x",
    transport: "stdio",
    era: "modern",
    events: false,
    eventsListChanged: false,
    tasks: false,
    tools: true,
    toolsListChanged: false,
  };
}

function harness(opts: {
  commands: Array<{ name: string }>;
  extensions?: string[];
  tools?: Array<{ name: string }>;
  builtinSettleMs?: number;
}) {
  const registered: string[] = [];
  let tools = opts.tools ?? [];
  const client = {
    name: "x",
    state: state(),
    async request(method: string): Promise<JsonObject> {
      if (method === "tools/list") {
        return {
          tools: [
            {
              name: "echo",
              description: "echo",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      }
      return {};
    },
  } as unknown as ServerClient;

  const pi = {
    getCommands: () => opts.commands,
    getSettings: () => (opts.extensions === undefined ? {} : { extensions: opts.extensions }),
    getAllTools: () => tools,
    registerTool: (def: { name: string }) => {
      registered.push(def.name);
    },
  } as unknown as ExtensionAPI;

  const host: EngineHost = {
    getClient: () => client,
    appendEntry: () => {},
    wake: () => {},
    log: () => {},
    signal: new AbortController().signal,
  };

  return {
    registered,
    setTools(next: Array<{ name: string }>) {
      tools = next;
    },
    api: createToolsFallback(pi, host, {
      builtinSettleMs: opts.builtinSettleMs ?? SETTLE_THAT_MUST_NOT_RUN_MS,
    }),
  };
}

test("builtin /mcp active: stand down immediately, even if tools appear after 120ms", async () => {
  const h = harness({ commands: [{ name: "mcp" }] });
  const started = Date.now();
  let appeared = false;
  const appear = setTimeout(() => {
    appeared = true;
    h.setTools([{ name: "mcp__x__echo" }]);
  }, 200);
  try {
    const owned = await h.api.activateIfUnowned(server("x"));
    const elapsed = Date.now() - started;
    assert.equal(owned, false);
    assert.equal(appeared, false);
    assert.ok(elapsed < 150, `activate waited ${elapsed}ms; builtinSettleMs must not delay`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(appeared, true);
    assert.deepEqual(h.registered, []);
  } finally {
    clearTimeout(appear);
    await h.api.shutdown();
  }
});

test("builtin absent: register fallback tools without waiting", async () => {
  const h = harness({ commands: [] });
  const started = Date.now();
  try {
    const owned = await h.api.activateIfUnowned(server("x"));
    assert.equal(owned, true);
    assert.ok(Date.now() - started < 150);
    assert.deepEqual(h.registered, ["mcp__x__echo"]);
  } finally {
    await h.api.shutdown();
  }
});

test("builtin disabled via -builtin:mcp: register fallback tools", async () => {
  const h = harness({ commands: [], extensions: ["other", "-builtin:mcp"] });
  try {
    const owned = await h.api.activateIfUnowned(server("x"));
    assert.equal(owned, true);
    assert.deepEqual(h.registered, ["mcp__x__echo"]);
  } finally {
    await h.api.shutdown();
  }
});

test("builtin disabled via !builtin:mcp: register fallback tools", async () => {
  const h = harness({ commands: [], extensions: ["!builtin:mcp"] });
  try {
    const owned = await h.api.activateIfUnowned(server("x"));
    assert.equal(owned, true);
    assert.deepEqual(h.registered, ["mcp__x__echo"]);
  } finally {
    await h.api.shutdown();
  }
});

test("builtin already owns mcp__x__*: stand down even though /mcp is absent", async () => {
  const h = harness({
    commands: [],
    tools: [{ name: "mcp__x__echo" }],
    builtinSettleMs: 0,
  });
  try {
    const owned = await h.api.activateIfUnowned(server("x"));
    assert.equal(owned, false);
    assert.deepEqual(h.registered, []);
  } finally {
    await h.api.shutdown();
  }
});
