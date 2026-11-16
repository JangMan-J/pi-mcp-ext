import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadServerConfigs, resolveConfigValue, createAuthResolver } from "../src/config.ts";

test("read-only configuration scopes, subscriptions, expansion and credential refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-config-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const cwd = join(root, "project");
  mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
  try {
    writeFileSync(join(root, "mcp.json"), "\uFEFF" + JSON.stringify({ mcpServers: {
      base: { command: "base", subscribe: ["*", { name: "changed", arguments: {}, delivery: "poll", maxAgeMs: 0, holdSettle: false }] },
      replace: { command: "old", subscribe: ["old"] },
      guarded: { command: "guarded" },
      bad: { type: "sse", url: "https://example.test" },
      invalidSub: { command: "ok", subscribe: [{ name: "x", maxAgeMs: -1 }] },
      notArray: { command: "ok", subscribe: "*" },
      "a-b": { command: "one" }, "a_b": { command: "two" },
    } }));
    write(join(cwd, CONFIG_DIR_NAME, "mcp.json"), { mcpServers: {
      base: { enabled: false }, replace: { command: "new", subscribe: ["new"] },
      guarded: { enabled: false, subscribe: ["*"] },
      unsafe: { url: "https://example.test", auth: { provider: "p" } },
    } });
    const opts = { cwd, isProjectTrusted: false, sessionServers: [
      { name: "a_b", config: { command: "session" } },
      { name: "extra", config: { command: "extra", subscribe: ["*"] } },
    ] };
    let result = await loadServerConfigs(opts);
    assert.equal(result.servers.find(s => s.name === "base")?.enabled, true);
    const original = result.servers.find(s => s.name === "replace");
    assert.equal(original?.transport === "stdio" && original.command, "old");
    result = await loadServerConfigs({ ...opts, isProjectTrusted: true });
    const base = result.servers.find(s => s.name === "base")!;
    assert.equal(base.enabled, false);
    assert.equal(base.timeoutMs, 60_000);
    assert.equal(base.subscribe?.[0].name, "*");
    assert.equal(base.subscribe?.[1].delivery, "poll");
    const replacement = result.servers.find(s => s.name === "replace")!;
    assert.equal(replacement.transport === "stdio" && replacement.command, "new");
    assert.deepEqual(replacement.subscribe, [{ name: "new" }]);
    assert.equal(result.servers.find(s => s.name === "guarded")?.enabled, true);
    assert.equal(result.servers.find(s => s.name === "guarded")?.subscribe, undefined);
    assert.equal(result.servers.some(s => s.name === "bad" || s.name === "unsafe" || s.name === "a_b"), false);
    assert.equal(result.servers.find(s => s.name === "extra")?.scope, "session");
    assert.equal(result.servers.find(s => s.name === "invalidSub")?.subscribe, undefined);
    assert.equal(result.servers.find(s => s.name === "notArray")?.subscribe, undefined);
    assert.ok(result.warnings.length >= 5);
    process.env.MCP_CONFIG_TEST = "value";
    assert.equal(resolveConfigValue("${MCP_CONFIG_TEST}/$MCP_CONFIG_TEST/$$/$!"), "value/value/$/!");
    assert.equal(resolveConfigValue("!printf ' fresh '"), "fresh");
    assert.throws(() => resolveConfigValue("!exit 1"));
    assert.throws(() => resolveConfigValue("!printf ''"));
    assert.throws(() => resolveConfigValue("${MCP_CONFIG_ABSENT}"), /MCP_CONFIG_ABSENT/);
    const server = { name: "remote", namespace: "mcp__remote", scope: "global" as const, transport: "http" as const, enabled: true, timeoutMs: 60000, url: "https://example.test", headers: {} };
    const url = String(new URL(server.url));
    const authPath = join(root, "mcp-auth.json");
    write(authPath, { [url]: { tokens: { access_token: "legacy" } } });
    const resolver = createAuthResolver(server, async () => "provider");
    assert.equal(await resolver.authorization(), "Bearer legacy");
    write(authPath, { [url]: { tokens: { access_token: "legacy" } }, [`${server.namespace}|${url}`]: { tokens: { access_token: "primary-new" } } });
    assert.equal(await resolver.refreshAfterUnauthorized(), true);
    assert.equal(await resolver.authorization(), "Bearer primary-new");
    assert.equal(await resolver.refreshAfterUnauthorized(), false);
    assert.equal(await createAuthResolver({ ...server, authProvider: "p" }, async () => "provider").authorization(), "Bearer provider");
    assert.equal(await createAuthResolver({ ...server, authProvider: "p", headers: { aUtHoRiZaTiOn: "Bearer ${MCP_CONFIG_TEST}" } }, async () => "provider").authorization(), "Bearer value");
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    delete process.env.MCP_CONFIG_TEST;
    rmSync(root, { recursive: true, force: true });
  }
});
