/**
 * Shared contract of pi-mcp-ext: MCP 2026-07-28 wire types (SEP-2575, SEP-3415, SEP-2663, SEP-2243)
 * and the internal seams between modules. Every other module imports from here; nothing here runs.
 */

// ---------------------------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------------------------

export const PROTOCOL_VERSION = "2026-07-28";
export const EXT_EVENTS = "io.modelcontextprotocol/events";
export const EXT_TASKS = "io.modelcontextprotocol/tasks";
export const EXT_SKILLS = "io.modelcontextprotocol/skills";
export const EXT_OAUTH_CLIENT_CREDENTIALS = "io.modelcontextprotocol/oauth-client-credentials";
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
export const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";
export const CLIENT_INFO = { name: "pi-mcp-ext", version: "0.1.0" } as const;

/** JSON-RPC and MCP error codes this package acts on. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,
  NotFound: -32023,
  Forbidden: -32024,
  ResourceExhausted: -32025,
  Unsupported: -32026,
} as const;

/** Codes that prove a server speaks 2026-07-28-era MCP even when it rejects the request. */
export const MODERN_ERROR_CODES: readonly number[] = [
  ErrorCode.HeaderMismatch,
  ErrorCode.MissingRequiredClientCapability,
  ErrorCode.UnsupportedProtocolVersion,
];

// ---------------------------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------------------------

export type RequestId = string | number;
export type JsonObject = Record<string, unknown>;

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: JsonObject & { _meta?: JsonObject };
}

export interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject & { _meta?: JsonObject };
}

export interface JSONRPCResultResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result: JsonObject;
}

export interface JSONRPCErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JSONRPCErrorResponse {
  jsonrpc: "2.0";
  id: RequestId | null;
  error: JSONRPCErrorObject;
}

export type JSONRPCResponse = JSONRPCResultResponse | JSONRPCErrorResponse;
export type JSONRPCMessage = JSONRPCRequest | JSONRPCNotification | JSONRPCResponse;

export function isResponse(msg: unknown): msg is JSONRPCResponse {
  return typeof msg === "object" && msg !== null && "id" in msg && ("result" in msg || "error" in msg);
}
export function isNotification(msg: unknown): msg is JSONRPCNotification {
  return typeof msg === "object" && msg !== null && "method" in msg && !("id" in msg);
}
export function isErrorResponse(msg: JSONRPCResponse): msg is JSONRPCErrorResponse {
  return "error" in msg;
}
/** `params._meta["io.modelcontextprotocol/subscriptionId"]` of a notification, if any. */
export function subscriptionIdOf(msg: JSONRPCNotification): RequestId | undefined {
  const id = (msg.params?._meta as JsonObject | undefined)?.[META_SUBSCRIPTION_ID];
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/** A JSON-RPC error returned by a server. */
export class McpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(error: JSONRPCErrorObject) {
    super(error.message);
    this.name = "McpRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export type TransportErrorKind =
  | "timeout" // per-request timer fired
  | "closed" // transport closed or process exited
  | "interrupted" // SSE / stream ended before the response for the request id
  | "http" // non-2xx HTTP status without a JSON-RPC error body
  | "network" // fetch failed
  | "needs-auth" // HTTP 401 that survived the mcp-auth.json re-read
  | "protocol" // unparseable or invalid response
  | "aborted"; // caller's AbortSignal

/** A failure below JSON-RPC: the server never produced a JSON-RPC response. */
export class McpTransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly status?: number;
  constructor(kind: TransportErrorKind, message: string, status?: number) {
    super(message);
    this.name = "McpTransportError";
    this.kind = kind;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// SEP-2575 stateless framing
// ---------------------------------------------------------------------------------------------

export interface Implementation {
  name: string;
  version: string;
  title?: string;
}

export interface ClientCapabilities {
  extensions: Record<string, JsonObject>;
  roots?: JsonObject;
  elicitation?: { form?: JsonObject; url?: JsonObject };
}

export interface ServerCapabilities {
  extensions?: Record<string, unknown>;
  tools?: JsonObject;
  resources?: JsonObject;
  prompts?: JsonObject;
  completions?: JsonObject;
  [key: string]: unknown;
}

export interface DiscoverResult {
  resultType: "complete";
  supportedVersions: string[];
  capabilities: ServerCapabilities;
  instructions?: string;
  _meta?: { [META_SERVER_INFO]?: Implementation } & JsonObject;
}

/** Filter of `subscriptions/listen` and of its acknowledgment. False/empty fields are omitted on the wire. */
export interface ListenFilter {
  eventsListChanged?: boolean;
  taskIds?: string[];
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}

export type McpLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

// ---------------------------------------------------------------------------------------------
// SEP-3415 events
// ---------------------------------------------------------------------------------------------

export type DeliveryMode = "poll" | "push" | "webhook";

export interface EventDescriptor {
  name: string;
  description?: string;
  delivery: DeliveryMode[];
  inputSchema?: JsonObject;
  payloadSchema?: JsonObject;
  _meta?: JsonObject;
}

export interface ListEventsResult {
  resultType: "complete";
  events: EventDescriptor[];
  nextCursor?: string;
}

export interface EventOccurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: JsonObject;
  /** Push per-event cursor; absent === null. */
  cursor?: string | null;
  _meta?: JsonObject;
}

export interface PollEventsParams {
  name: string;
  arguments?: JsonObject;
  cursor: string | null;
  maxAgeMs?: number;
  maxEvents?: number;
}

export interface PollEventsResult {
  resultType: "complete";
  events: EventOccurrence[];
  cursor?: string | null;
  truncated?: boolean;
  hasMore: boolean;
  nextPollMs?: number;
}

export interface StreamEventsParams {
  name: string;
  arguments?: JsonObject;
  cursor?: string | null;
  maxAgeMs?: number;
}

// ---------------------------------------------------------------------------------------------
// SEP-2663 tasks
// ---------------------------------------------------------------------------------------------

export type TaskStatus = "working" | "input_required" | "completed" | "cancelled" | "failed";
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "cancelled", "failed"];

export interface Task {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}

export interface CreateTaskResult extends Task {
  resultType: "task";
  _meta?: JsonObject;
}

/** An MRTR request a server asks the client to fulfil (`elicitation/create`, `sampling/createMessage`, `roots/list`). */
export interface ServerClientRequest {
  method: string;
  params?: JsonObject;
}

export type WorkingTask = Task & { status: "working" };
export type InputRequiredTask = Task & { status: "input_required"; inputRequests: Record<string, ServerClientRequest> };
export type CompletedTask = Task & { status: "completed"; result: JsonObject };
export type FailedTask = Task & { status: "failed"; error: JSONRPCErrorObject };
export type CancelledTask = Task & { status: "cancelled" };
export type DetailedTask = WorkingTask | InputRequiredTask | CompletedTask | FailedTask | CancelledTask;

export interface CallToolResult {
  resultType?: "complete";
  content: Array<JsonObject & { type: string }>;
  structuredContent?: JsonObject;
  isError?: boolean;
  _meta?: JsonObject;
}

export interface InputRequiredResult {
  resultType: "input_required";
  inputRequests?: Record<string, ServerClientRequest>;
}

export type ToolCallOutcome = CallToolResult | InputRequiredResult | CreateTaskResult;

// ---------------------------------------------------------------------------------------------
// Transport seam (spec §3)
// ---------------------------------------------------------------------------------------------

export interface TransportRequestOptions {
  signal?: AbortSignal;
  /** undefined disables the per-request timer (used for open streams). */
  timeoutMs?: number;
  onNotification?: (msg: JSONRPCNotification) => void;
  /** HTTP only: extra headers, e.g. `Mcp-Param-*` (SEP-2243). Ignored by stdio. */
  headers?: Record<string, string>;
}

export interface OpenStreamHandle {
  readonly requestId: RequestId;
  /** Resolves with the final result (graceful close), or undefined when the stream ended without one. Rejects on JSON-RPC error. */
  readonly done: Promise<JSONRPCResultResponse | undefined>;
  cancel(reason?: string): Promise<void>;
}

export interface Mcp2026Transport {
  readonly kind: "stdio" | "http";
  /** Resolves with the JSON-RPC response (including error responses); rejects with McpTransportError. */
  request(msg: JSONRPCRequest, opts?: TransportRequestOptions): Promise<JSONRPCResponse>;
  openStream(
    msg: JSONRPCRequest,
    onNotification: (msg: JSONRPCNotification) => void,
    opts?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<OpenStreamHandle>;
  onUnexpectedClose(listener: (err?: Error) => void): () => void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Configuration seam (spec §2.2, §2.3, §3.1)
// ---------------------------------------------------------------------------------------------

export type ConfigScope = "global" | "project" | "session";
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
export type JwtSigningAlgorithm = "RS256" | "RS384" | "RS512" | "ES256" | "ES384" | "ES512" | "EdDSA";

export interface OAuthClientCredentialsConfig {
  clientId: string;
  /** Raw secret (expanded via resolveConfigValue on connect). Mutually exclusive or paired with privateKey. */
  clientSecret?: string;
  /** Raw PEM private key (expanded via resolveConfigValue on connect) for RFC 7523 private_key_jwt. */
  privateKey?: string;
  algorithm?: JwtSigningAlgorithm;
  kid?: string;
  scope?: string;
  /** Pinned authorization server issuer identifier (validated strictly before sending credentials). */
  issuer?: string;
  /** Explicit authorization server metadata URL override (https or loopback). */
  authServerMetadataUrl?: string;
  /** Explicit token endpoint URL override (https or loopback; requires issuer for private_key_jwt). */
  tokenEndpoint?: string;
}

interface ResolvedServerBase {
  name: string;
  /** `"mcp__" + name.replace(/-/g, "_")` */
  namespace: string;
  scope: ConfigScope;
  enabled: boolean;
  /** `config.timeout` (seconds, default 60) in ms. */
  timeoutMs: number;
  description?: string;
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
}

export interface ResolvedStdioServer extends ResolvedServerBase {
  transport: "stdio";
  command: string;
  args: string[];
  /** Raw values; expanded with resolveConfigValue on each connect. */
  env: Record<string, string>;
  cwd?: string;
}

export interface ResolvedHttpServer extends ResolvedServerBase {
  transport: "http";
  url: string;
  /** Raw values; expanded with resolveConfigValue on each request. */
  headers: Record<string, string>;
  /** Set only when allowed (global or session scope, https or loopback URL). */
  authProvider?: string;
  /** OAuth 2.0 client_credentials settings (allowed only in global or session scope on https or loopback). */
  clientCredentials?: OAuthClientCredentialsConfig;
}

export type ResolvedServer = ResolvedStdioServer | ResolvedHttpServer;

export interface ConfigWarning {
  scope: ConfigScope;
  server?: string;
  message: string;
}

export interface ConfigLoadResult {
  servers: ResolvedServer[];
  warnings: ConfigWarning[];
}

export interface ConfigLoadOptions {
  cwd: string;
  isProjectTrusted: boolean;
  /** Servers from `pi.getMcpServers()`: `{ name, config }` with the raw mcp.json-shaped config. */
  sessionServers: Array<{ name: string; config: JsonObject }>;
}

/** Per-request `Authorization` for one HTTP server (spec §2.3). Never writes anything. */
export interface AuthResolver {
  /** Resolved `Authorization` value or undefined. */
  authorization(): Promise<string | undefined>;
  /**
   * After a 401: wait 250 ms, re-read mcp-auth.json, and return true when the token changed
   * (the caller retries once). False means the server needs sign-in.
   */
  refreshAfterUnauthorized(): Promise<boolean>;
}

/** Resolves a provider token through Pi (`ctx.modelRegistry.getProviderAuth(provider)`). */
export type ProviderTokenLookup = (provider: string) => Promise<string | undefined>;

// ---------------------------------------------------------------------------------------------
// Client seam (spec §4)
// ---------------------------------------------------------------------------------------------

export type ServerEra =
  | "unknown" // not probed yet
  | "probing"
  | "modern" // 2026-07-28 with events and/or tasks
  | "modern-dormant" // 2026-07-28 without events or tasks
  | "unsupported-modern-version"
  | "legacy" // builtin:mcp owns it
  | "needs-auth"
  | "error" // config resolution or transport failure (message in ServerState.error)
  | "disabled";

export interface ServerState {
  name: string;
  transport: "stdio" | "http";
  era: ServerEra;
  error?: string;
  supportedVersions?: string[];
  /** `capabilities.extensions["io.modelcontextprotocol/events"]` present. */
  events: boolean;
  /** `listChanged === true` on the events extension settings. */
  eventsListChanged: boolean;
  /** `capabilities.extensions["io.modelcontextprotocol/tasks"]` present. */
  tasks: boolean;
  /** `capabilities.tools` present. */
  tools?: boolean;
  toolsListChanged?: boolean;
  /** `capabilities.resources` present. */
  resources?: boolean;
  resourcesSubscribe?: boolean;
  resourcesListChanged?: boolean;
  /** `capabilities.prompts` present. */
  prompts?: boolean;
  promptsListChanged?: boolean;
  /** `capabilities.completions` present. */
  completions?: boolean;
  /** `capabilities.extensions["io.modelcontextprotocol/skills"]` AND `capabilities.resources` present. */
  skills?: boolean;
  skillsDirectoryRead?: boolean;
  serverInfo?: Implementation;
  instructions?: string;
}

export interface McpLogMessage {
  level: McpLogLevel;
  logger?: string;
  data: unknown;
}

export interface ClientRequestOptions {
  signal?: AbortSignal;
  /** Default: the server's timeoutMs. */
  timeoutMs?: number;
  onNotification?: (msg: JSONRPCNotification) => void;
  onLog?: (entry: McpLogMessage) => void;
  /** HTTP only: extra headers (Mcp-Param-*). */
  headers?: Record<string, string>;
  /** SEP-2575 per-request log level (`io.modelcontextprotocol/logLevel`). */
  logLevel?: McpLogLevel;
}

/** Interest a module registers in the server's single `subscriptions/listen` stream. */
export type ListenOwner = "events" | "tasks" | "tools" | "prompts" | "resources";

export interface ServerClient {
  readonly name: string;
  readonly config: ResolvedServer;
  readonly state: ServerState;
  /** Probe with `server/discover` and classify (spec §4.3). Never throws. */
  discover(): Promise<ServerState>;
  /**
   * Send one request with the stateless `_meta` merged into `params._meta`. Resolves with `result`;
   * rejects with McpRpcError (JSON-RPC error) or McpTransportError. Read-only methods are retried once
   * on transient HTTP errors by the transport.
   */
  request<T = JsonObject>(method: string, params?: JsonObject, opts?: ClientRequestOptions): Promise<T>;
  /** Open a long-lived stream request (`events/stream`); `_meta` is added. */
  openStream(
    method: string,
    params: JsonObject,
    onNotification: (msg: JSONRPCNotification) => void,
    opts?: {
      signal?: AbortSignal;
      headers?: Record<string, string>;
      logLevel?: McpLogLevel;
      onLog?: (entry: McpLogMessage) => void;
    },
  ): Promise<OpenStreamHandle>;
  /**
   * Set one owner's share of the `subscriptions/listen` filter. The client unions all owners, holds at
   * most one stream, replaces it atomically when the union changes, and closes it when the union is empty.
   */
  setListenInterest(owner: ListenOwner, filter: ListenFilter): void;
  /** Notifications on the listen stream after acknowledgment (`notifications/tasks`, `notifications/events/list_changed`). */
  onListenNotification(listener: (msg: JSONRPCNotification) => void): () => void;
  /** Fires with the honored filter on every acknowledgment, and with undefined when the stream drops or closes. */
  onListenState(listener: (honored: ListenFilter | undefined) => void): () => void;
  /** Close any open idle transport without permanently closing the client (reconnects lazily on next call). */
  park?(): Promise<void>;
  /** Cancel streams and close the transport. Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Engine seams (spec §5.3, §6) — events.ts and tasks.ts depend only on these, index.ts wires them.
// ---------------------------------------------------------------------------------------------

export const CUSTOM_SUBSCRIPTIONS = "mcp-ext:subscriptions";
export const CUSTOM_CURSORS = "mcp-ext:cursors";
export const CUSTOM_TASKS = "mcp-ext:tasks";
export const CUSTOM_RESOURCE_SUBSCRIPTIONS = "mcp-ext:resource-subscriptions";
export const CUSTOM_SKILL_APPROVALS = "mcp-ext:skill-approvals";
export const MESSAGE_EVENT = "mcp-event";
export const MESSAGE_TASK = "mcp-task";
export const MESSAGE_RESOURCE = "mcp-resource";

export type DeliveryPreference = "auto" | "push" | "poll";

export interface SubscriptionRecord {
  subKey: string;
  server: string;
  name: string;
  arguments?: JsonObject;
  delivery: DeliveryPreference;
  maxAgeMs?: number;
  holdSettle: boolean;
}

export type SubscriptionEntry =
  | { op: "upsert"; subscription: SubscriptionRecord; cursor?: string | null }
  | { op: "remove"; subKey: string; server: string };

export interface CursorEntry {
  server: string;
  subKey: string;
  cursor: string | null;
  truncated?: boolean;
  recentEventIds: string[];
  updatedAt: string;
}

export interface TaskRecord {
  server: string;
  taskId: string;
  toolName: string;
  status: TaskStatus | "expired" | "not_found_or_expired";
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  surfacedInputKeys: string[];
  answeredInputKeys: string[];
  /** Set when cancelled locally through tasks/cancel. */
  locallyCancelled?: boolean;
}

/** Host services the engines use; index.ts implements it over the Pi API. */
export interface EngineHost {
  /** Client of a server, or undefined when unknown/not modern. */
  getClient(server: string): ServerClient | undefined;
  /** `pi.appendEntry(customType, data)`. */
  appendEntry(customType: string, data: unknown): void;
  /** Steer a wake message: `pi.sendMessage({customType, content, display: true, details}, {triggerTurn: true, deliverAs: "steer"})`. */
  wake(customType: typeof MESSAGE_EVENT | typeof MESSAGE_TASK | typeof MESSAGE_RESOURCE, content: string, details: unknown): void;
  /** Footer status / diagnostics; may be a no-op. */
  log(level: "info" | "warn" | "error", message: string): void;
  /** Optional interactive elicitation handler for SEP-2663 input_required tasks when UI is present. */
  fulfillElicitation?(
    server: string,
    params: JsonObject,
  ): Promise<{ action: "accept" | "decline" | "cancel"; content?: JsonObject } | undefined>;
  /** Aborted on session_shutdown. */
  readonly signal: AbortSignal;
}

/** A batch of event occurrences ready for the model (after dedup), one per subscription per batch. */
export interface EventDelivery {
  server: string;
  subKey: string;
  name: string;
  truncated: boolean;
  occurrences: EventOccurrence[];
}

export interface SubscribeRequest {
  server: string;
  name: string;
  arguments?: JsonObject;
  delivery?: DeliveryPreference;
  /** undefined = use persisted cursor; null = from now. */
  cursor?: string | null;
  maxAgeMs?: number;
  holdSettle?: boolean;
}

export interface EventsEngineApi {
  /** Rebuild subscriptions and cursors from session entries (active branch + all entries), then start them. */
  restore(branch: readonly unknown[], allEntries: readonly unknown[]): void;
  /** A server became modern with events: (re)start its subscriptions. */
  serverReady(server: string): void;
  list(server: string, opts?: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void }): Promise<EventDescriptor[]>;
  subscribe(req: SubscribeRequest): Promise<SubscriptionRecord>;
  unsubscribe(server: string, name: string, args?: JsonObject): Promise<boolean>;
  subscriptions(): Array<SubscriptionRecord & { cursor: string | null; active: boolean; mode?: "push" | "poll" }>;
  /** One-shot `events/poll` without a subscription. */
  poll(
    server: string,
    params: PollEventsParams,
    opts?: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void },
  ): Promise<PollEventsResult>;
  /** Whether a subscription with holdSettle is active. */
  holdsSettle(): boolean;
  /** Count of open push streams (for the footer). */
  activeStreams(): number;
  /** Notifies after each wake (for settle hold). */
  onWake(listener: () => void): () => void;
  /** Notifies when subscription/stream/hold state changes without requiring polling. */
  onStateChange?(listener: () => void): () => void;
  /** Stop all streams/timers and flush dirty cursors. */
  shutdown(): Promise<void>;
}

export interface TasksEngineApi {
  restore(allEntries: readonly unknown[]): void;
  serverReady(server: string): void;
  /** `tools/call` with tasks in _meta; tracks a returned task. Returns the raw outcome. */
  call(
    server: string,
    tool: string,
    args?: JsonObject,
    signal?: AbortSignal,
    opts?: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void },
  ): Promise<ToolCallOutcome>;
  get(
    server: string,
    taskId: string,
    opts?: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void },
  ): Promise<DetailedTask>;
  update(
    server: string,
    taskId: string,
    inputResponses: JsonObject,
    opts?: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void },
  ): Promise<void>;
  cancel(
    server: string,
    taskId: string,
    opts?: { logLevel?: McpLogLevel; onLog?: (entry: McpLogMessage) => void },
  ): Promise<void>;
  active(): TaskRecord[];
  /** Whether any task is working or input_required. */
  hasPending(): boolean;
  onWake(listener: () => void): () => void;
  /** Notifies when task state changes without requiring polling. */
  onStateChange?(listener: () => void): () => void;
  shutdown(): Promise<void>;
}
