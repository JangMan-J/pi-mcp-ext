import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
// Resolve Pi's internal validator beside its public entry point.
const { validateMcpServerConfig } = await import(new URL("./core/mcp-servers.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
  validateMcpServerConfig(name: string, raw: unknown): string | Record<string, any>;
};
import { parseClientCredentialsConfig, createClientCredentialsResolver } from "./oauth-client-credentials.ts";
import type { AuthResolver, ConfigLoadOptions, ConfigScope, ConfigWarning, McpExposure, ProviderTokenLookup, ResolvedHttpServer, ResolvedServer } from "./types.ts";

export interface DeclaredSubscription {
  name: string;
  arguments?: Record<string, unknown>;
  delivery?: "auto" | "push" | "poll";
  maxAgeMs?: number;
  holdSettle?: boolean;
}
export type ConfiguredServer = ResolvedServer & { subscribe?: DeclaredSubscription[] };
export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\")) ? join(homedir(), p.slice(2)) : p;
}
export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? expandHome(process.env.PI_CODING_AGENT_DIR) : join(homedir(), CONFIG_DIR_NAME, "agent");
}
export function mcpNamespace(name: string): string { return "mcp__" + name.replace(/-/g, "_"); }
export function resolveConfigValue(value: string): string {
  if (value.startsWith("!")) {
    let output: string;
    try { output = execSync(value.slice(1), { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); }
    catch { throw new Error("Failed to resolve MCP config shell command"); }
    if (!output) throw new Error("MCP config shell command returned empty output");
    return output;
  }
  return value.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    if (match === "$$") return "$";
    if (match === "$!") return "!";
    const name = braced ?? bare;
    const result = process.env[name];
    if (!result) throw new Error(`Missing environment variable: ${name}`);
    return result;
  });
}
function record(v: unknown): v is Record<string, any> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function subscriptions(value: unknown): DeclaredSubscription[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: DeclaredSubscription[] = [];
  for (const raw of value) {
    const v = typeof raw === "string" ? { name: raw } : raw;
    if (!record(v) || typeof v.name !== "string" || !v.name.trim() ||
      (v.arguments !== undefined && !record(v.arguments)) ||
      (v.delivery !== undefined && !["auto", "push", "poll"].includes(v.delivery)) ||
      (v.maxAgeMs !== undefined && (!Number.isInteger(v.maxAgeMs) || v.maxAgeMs < 0)) ||
      (v.holdSettle !== undefined && typeof v.holdSettle !== "boolean")) return undefined;
    result.push({ name: v.name, ...(v.arguments === undefined ? {} : { arguments: v.arguments }), ...(v.delivery === undefined ? {} : { delivery: v.delivery }), ...(v.maxAgeMs === undefined ? {} : { maxAgeMs: v.maxAgeMs }), ...(v.holdSettle === undefined ? {} : { holdSettle: v.holdSettle }) });
  }
  return result;
}
export async function loadServerConfigs(opts: ConfigLoadOptions): Promise<{ servers: ConfiguredServer[]; warnings: ConfigWarning[] }> {
  const entries = new Map<string, { config: Record<string, any>; scope: ConfigScope }>();
  const warnings: ConfigWarning[] = [];
  function add(name: string, raw: unknown, scope: ConfigScope) {
    const warn = (message: string) => warnings.push({ scope, server: name, message });
    if (scope === "session" && [...entries.keys()].some(n => mcpNamespace(n) === mcpNamespace(name))) return;
    if (scope === "project" && record(raw) && raw.command === undefined && raw.url === undefined && raw.type === undefined) {
      const base = entries.get(name);
      if (!base) { warn("Partial override needs a global server"); return; }
      if (Object.keys(raw).some(k => !["enabled", "exposure", "toolExposure"].includes(k))) { warn("An override can only set enabled, exposure, toolExposure"); return; }
      const config = validateMcpServerConfig(name, { ...base.config, ...raw });
      if (typeof config === "string") warn(config);
      else entries.set(name, { ...base, config });
      return;
    }
    const config = validateMcpServerConfig(name, raw);
    if (typeof config === "string") { warn(config); return; }
    if ([...entries.keys()].some(n => n !== name && mcpNamespace(n) === mcpNamespace(name))) { warn("Server namespace conflicts with an earlier entry"); return; }
    if (scope === "project" && "url" in config && config.auth) { warn("auth is only allowed in global or session scope"); return; }
    entries.set(name, { config, scope });
  }
  function file(path: string, scope: ConfigScope) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") warnings.push({ scope, message: `${path}: ${String(e)}` }); return; }
    if (!record(parsed) || (parsed.mcpServers !== undefined && !record(parsed.mcpServers))) { warnings.push({ scope, message: `${path}: expected an mcpServers object` }); return; }
    for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) add(name, raw, scope);
  }
  file(join(getAgentDir(), "mcp.json"), "global");
  if (opts.isProjectTrusted) file(join(opts.cwd, CONFIG_DIR_NAME, "mcp.json"), "project");
  for (const s of opts.sessionServers) add(s.name, s.config, "session");
  const servers: ConfiguredServer[] = [];
  for (const [name, { config: c, scope }] of entries) {
    const base = {
      name,
      namespace: mcpNamespace(name),
      scope,
      enabled: c.enabled !== false,
      timeoutMs: (c.timeout ?? 60) * 1000,
      ...(typeof c.description === "string" ? { description: c.description } : {}),
      ...(typeof c.exposure === "string" ? { exposure: c.exposure as McpExposure } : {}),
      ...(record(c.toolExposure) ? { toolExposure: c.toolExposure as Record<string, McpExposure> } : {}),
    };
    let server: ConfiguredServer;
    if (typeof c.url === "string" && c.type !== "stdio") {
      const cc = parseClientCredentialsConfig(c, c.url, scope);
      if (cc.warning) warnings.push({ scope, server: name, message: cc.warning });
      server = {
        ...base,
        transport: "http",
        url: c.url,
        headers: c.headers ?? {},
        ...(c.auth ? { authProvider: c.auth.provider } : {}),
        ...(cc.config ? { clientCredentials: cc.config } : {}),
      };
    } else {
      server = {
        ...base,
        transport: "stdio",
        command: c.command,
        args: c.args ?? [],
        env: c.env ?? {},
        ...(c.cwd === undefined ? {} : { cwd: c.cwd }),
      };
    }
    if (c.subscribe !== undefined) {
      const sub = subscriptions(c.subscribe);
      if (sub) server.subscribe = sub;
      else warnings.push({ scope, server: name, message: "Invalid subscribe value; ignored" });
    }
    servers.push(server);
  }
  return { servers, warnings };
}
export function createAuthResolver(server: ResolvedHttpServer, providerToken: ProviderTokenLookup, fetchOverride?: typeof fetch): AuthResolver {
  const ccResolver = server.clientCredentials
    ? createClientCredentialsResolver(server, { fetch: fetchOverride, resolveValue: resolveConfigValue })
    : undefined;
  const path = join(getAgentDir(), "mcp-auth.json");
  let signature = "", states: Record<string, any> = {}, last: string | undefined;
  function stored(): string | undefined {
    try {
      const st = statSync(path), sig = `${st.mtimeMs}:${st.size}`;
      if (sig !== signature) {
        const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
        states = record(parsed) ? parsed : {}; signature = sig;
      }
    } catch { states = {}; signature = ""; }
    const url = String(new URL(server.url));
    const token = (states[`${server.namespace}|${url}`] ?? states[url])?.tokens?.access_token;
    return typeof token === "string" && token ? `Bearer ${token}` : undefined;
  }
  async function resolve(): Promise<string | undefined> {
    const header = Object.entries(server.headers).find(([key]) => key.toLowerCase() === "authorization");
    if (header) return resolveConfigValue(header[1]);
    if (server.authProvider) { const token = await providerToken(server.authProvider); return token ? `Bearer ${token}` : undefined; }
    if (ccResolver) return ccResolver.authorization();
    return stored();
  }
  return {
    async authorization() { last = await resolve(); return last; },
    async refreshAfterUnauthorized() {
      const header = Object.entries(server.headers).find(([key]) => key.toLowerCase() === "authorization");
      if (!header && !server.authProvider && ccResolver) {
        return ccResolver.refreshAfterUnauthorized();
      }
      const before = last;
      await new Promise(resolve => setTimeout(resolve, 250));
      last = await resolve();
      return last !== before;
    },
  };
}
