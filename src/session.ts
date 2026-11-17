/**
 * Seam: one Pi session's MCP runtime — configured servers, clients, the six engines, and their
 * lifecycle ordering.
 *
 * Owns config reload reconciliation (attach, reconfigure, reap), probe → `serverReady` fan-out,
 * `serverRemoved` fan-out on detach, branch restore, pre-abort `flushPending`, settle holding,
 * and shutdown. Tool and command handlers call `withServer`, which absorbs waiting on config
 * reloads and probes, capability checks, per-request log collection, and needs-auth error
 * normalization.
 *
 * SEAM STUB: signatures are fixed; `src/index.ts` migrates onto this in the session slice.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptsEngineApi } from "./prompts.ts";
import type { ResourcesEngineApi } from "./resources.ts";
import type { SkillsEngineApi } from "./skills.ts";
import type { ToolsFallbackApi } from "./tools-fallback.ts";
import type {
  ConfigLoadOptions,
  EventsEngineApi,
  McpLogLevel,
  McpLogMessage,
  ServerClient,
  ServerState,
  TasksEngineApi,
} from "./types.ts";

export type CapabilityKind = "events" | "tasks" | "resources" | "prompts" | "completions" | "skills";

export interface ServerCallRequest {
  server: string;
  /** Required server capability; omitted means "configured, enabled and modern". */
  capability?: CapabilityKind;
  logLevel?: McpLogLevel;
  signal?: AbortSignal;
  /** Latest Pi context (UI availability for elicitation and skill approval). */
  ctx?: ExtensionContext;
}

export interface ServerCallScope {
  client: ServerClient;
  /** Pass to engine calls so request-scoped `notifications/message` frames are collected. */
  logOpts: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void };
}

export interface ServerCallResult<T> {
  value: T;
  /** Formatted request-scoped log lines, in arrival order. */
  logs: string[];
}

export interface McpSession {
  /** Aborts when the session shuts down. */
  readonly signal: AbortSignal;
  readonly events: EventsEngineApi;
  readonly tasks: TasksEngineApi;
  readonly resources: ResourcesEngineApi;
  readonly prompts: PromptsEngineApi;
  readonly skills: SkillsEngineApi;
  readonly toolsFallback: ToolsFallbackApi;
  /**
   * Wait for pending config reload and the server's probe, require `capability`, run `fn`,
   * and return its value with collected logs. Rejects with a user-facing `Error` for unknown,
   * disabled, legacy, needs-auth, unsupported-version, or capability-missing servers, and
   * normalizes needs-auth transport errors thrown by `fn`.
   */
  withServer<T>(req: ServerCallRequest, fn: (scope: ServerCallScope) => Promise<T>): Promise<ServerCallResult<T>>;
  /** Load config and reconcile clients (serialized; removed/disabled/reconfigured servers are reaped). */
  reconcile(options: ConfigLoadOptions): Promise<void>;
  /** Restore engines from the active branch (and all entries for cursors/approvals). */
  restoreBranch(branch: readonly unknown[], allEntries: readonly unknown[]): void;
  /** Current state of every configured server, after pending reload and probes settle. */
  servers(signal?: AbortSignal): Promise<ServerState[]>;
  /** True while any task is pending or any holdSettle subscription/watch is honored. */
  holdsSettle(): boolean;
  /** Flush pending wakes, abort, shut every engine and client down, and clean temp files. Idempotent. */
  shutdown(ctx?: ExtensionContext): Promise<void>;
}

export function createMcpSession(_pi: ExtensionAPI, _ctx: ExtensionContext): McpSession {
  throw new Error("session.createMcpSession: seam stub, not implemented");
}
