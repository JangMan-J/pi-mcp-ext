import { backgroundTimer } from "./timer.ts";
import { resolveConfigValueAsync } from "./config.ts";
import { paginateMcp } from "./framing.ts";
import { createHttpTransport, paramHeaders, validateXMcpHeaders } from "./transport-http.ts";
import { createStdioTransport } from "./transport-stdio.ts";
import {
  CLIENT_INFO,
  ErrorCode,
  EXT_EVENTS,
  EXT_OAUTH_CLIENT_CREDENTIALS,
  EXT_SKILLS,
  EXT_TASKS,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_LOG_LEVEL,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  McpRpcError,
  McpTransportError,
  PROTOCOL_VERSION,
  isErrorResponse,
  subscriptionIdOf,
} from "./types.ts";
import type {
  AuthResolver,
  ClientRequestOptions,
  DiscoverResult,
  Implementation,
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResultResponse,
  JsonObject,
  ListenFilter,
  ListenOwner,
  Mcp2026Transport,
  McpLogLevel,
  McpLogMessage,
  OpenStreamHandle,
  RequestId,
  ResolvedServer,
  ServerClient,
  ServerState,
} from "./types.ts";

const TRACEPARENT_RE = /^[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
const PRINTABLE_HEADER_RE = /^[\t\x20-\x7e]+$/;

/** Extract valid W3C OpenTelemetry trace context (`traceparent`, `tracestate`, `baggage`) (`basic/index.md`). */
export function extractTraceMeta(
  source?: Record<string, string | undefined>,
): JsonObject {
  const out: JsonObject = {};
  if (!source) return out;
  const tp = (source.traceparent ?? source.TRACEPARENT)?.trim();
  if (tp && TRACEPARENT_RE.test(tp)) {
    out.traceparent = tp;
  }
  const ts = (source.tracestate ?? source.TRACESTATE)?.trim();
  if (ts && PRINTABLE_HEADER_RE.test(ts)) {
    out.tracestate = ts;
  }
  const bag = (source.baggage ?? source.BAGGAGE)?.trim();
  if (bag && PRINTABLE_HEADER_RE.test(bag)) {
    out.baggage = bag;
  }
  return out;
}

export interface BuildMetaOptions {
  roots?: boolean;
  elicitation?: boolean;
  skills?: boolean;
  oauthClientCredentials?: boolean;
  traceContext?: Record<string, string | undefined>;
}

/** Stateless capabilities and optional W3C trace context sent on every request (SEP-2575, SEP-414). */
export function buildMeta(opts?: BuildMetaOptions): Record<string, unknown> {
  const extensions: Record<string, JsonObject> = {
    [EXT_EVENTS]: {},
    [EXT_TASKS]: {},
  };
  if (opts?.skills) extensions[EXT_SKILLS] = {};
  if (opts?.oauthClientCredentials) extensions[EXT_OAUTH_CLIENT_CREDENTIALS] = {};
  const capabilities: JsonObject = { extensions };
  if (opts?.roots) capabilities.roots = {};
  if (opts?.elicitation) capabilities.elicitation = { form: {}, url: {} };
  return {
    ...extractTraceMeta(opts?.traceContext),
    [META_PROTOCOL_VERSION]: PROTOCOL_VERSION,
    [META_CLIENT_CAPABILITIES]: capabilities,
    [META_CLIENT_INFO]: { ...CLIENT_INFO },
  };
}

export interface ClientDeps {
  cwd: string;
  auth?: AuthResolver;
  createTransport?: (config: ResolvedServer) => Promise<Mcp2026Transport>;
  meta?: () => Record<string, unknown>;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  backoff?: { baseMs?: number; maxMs?: number };
  listenAckTimeoutMs?: number;
  autoParkIdleStdio?: () => boolean;
  fulfillInputRequests?: (
    server: string,
    inputRequests: Record<string, { method: string; params?: JsonObject }>,
  ) => Promise<JsonObject | undefined>;
}

const MAX_MRTR_ROUNDS = 8;

type HeaderDescriptor = { header: string; path: string[] };

type ListenAttempt = {
  id: RequestId;
  filter: ListenFilter;
  key: string;
  transport?: Mcp2026Transport;
  handle?: OpenStreamHandle;
  ackTimer?: ReturnType<typeof setTimeout>;
  acknowledged: boolean;
  retired: boolean;
  finished: boolean;
  cancelSent: boolean;
};

const noAuth: AuthResolver = {
  async authorization() { return undefined; },
  async refreshAfterUnauthorized() { return false; },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeFilter(filter: ListenFilter): ListenFilter {
  const normalized: ListenFilter = {};
  if (filter.eventsListChanged === true) normalized.eventsListChanged = true;
  const taskIds = [...new Set(filter.taskIds ?? [])];
  if (taskIds.length) normalized.taskIds = taskIds;
  if (filter.toolsListChanged === true) normalized.toolsListChanged = true;
  if (filter.promptsListChanged === true) normalized.promptsListChanged = true;
  if (filter.resourcesListChanged === true) normalized.resourcesListChanged = true;
  const resourceSubs = [...new Set(filter.resourceSubscriptions ?? [])];
  if (resourceSubs.length) normalized.resourceSubscriptions = resourceSubs;
  return normalized;
}

function isModernError(code: number): boolean {
  return code === ErrorCode.HeaderMismatch
    || code === ErrorCode.MissingRequiredClientCapability
    || code === ErrorCode.UnsupportedProtocolVersion;
}

function supportedVersions(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const supported = (value as JsonObject).supported;
  return Array.isArray(supported) && supported.every(version => typeof version === "string")
    ? supported
    : undefined;
}

function isDiscoverResult(result: JsonObject): result is JsonObject & DiscoverResult {
  return (result.resultType === "complete" || result.resultType === undefined)
    && Array.isArray(result.supportedVersions)
    && result.supportedVersions.every(version => typeof version === "string");
}

function isPermanentListenError(err: unknown): boolean {
  if (!(err instanceof McpRpcError)) return false;
  return (
    err.code === ErrorCode.MethodNotFound
    || err.code === ErrorCode.MissingRequiredClientCapability
    || err.code === ErrorCode.UnsupportedProtocolVersion
    || err.code === ErrorCode.Forbidden
    || err.code === ErrorCode.Unsupported
  );
}

/** Create one lazy, per-server protocol client. */
export function createServerClient(config: ResolvedServer, deps: ClientDeps): ServerClient {
  const state: ServerState = {
    name: config.name,
    transport: config.transport,
    era: config.enabled ? "unknown" : "disabled",
    events: false,
    eventsListChanged: false,
    tasks: false,
  };
  const makeMeta = deps.meta ?? (() => buildMeta());
  const log = deps.log ?? (() => {});
  const baseBackoff = deps.backoff?.baseMs ?? 500;
  const maxBackoff = deps.backoff?.maxMs ?? 30_000;

  const listenAckTimeoutMs = deps.listenAckTimeoutMs ?? 15_000;

  let sequence = 0;
  let transportPromise: Promise<Mcp2026Transport> | undefined;
  let currentTransport: Mcp2026Transport | undefined;
  let removeCloseListener: (() => void) | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let inFlightCount = 0;
  let openUserStreams = 0;
  let idleParkTimer: ReturnType<typeof setTimeout> | undefined;
  let listenUnsupported = false;

  const owners = new Map<ListenOwner, ListenFilter>();
  const notificationListeners = new Set<(msg: JSONRPCNotification) => void>();
  const stateListeners = new Set<(honored: ListenFilter | undefined) => void>();
  let desired: ListenFilter = {};
  let desiredKey = "{}";
  let active: ListenAttempt | undefined;
  let pending: ListenAttempt | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let nextBackoff = baseBackoff;

  function clearIdleParkTimer(): void {
    if (idleParkTimer) {
      clearTimeout(idleParkTimer);
      idleParkTimer = undefined;
    }
  }

  function scheduleIdleStdioParkIfEligible(): void {
    clearIdleParkTimer();
    if (
      closed
      || config.transport !== "stdio"
      || !deps.autoParkIdleStdio?.()
      || inFlightCount > 0
      || openUserStreams > 0
      || desiredKey !== "{}"
      || active
      || pending
    ) {
      return;
    }
    idleParkTimer = setTimeout(() => {
      idleParkTimer = undefined;
      void park();
    }, 250);
    backgroundTimer(idleParkTimer);
  }

  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence}`;
  }

  function requestMessage(
    method: string,
    params?: JsonObject,
    id: RequestId = nextId("request"),
    logLevel?: McpLogLevel,
  ): JSONRPCRequest {
    const requestParams: JsonObject = { ...params };
    const coreMeta = makeMeta();
    const meta: JsonObject = { ...coreMeta, ...(params?._meta as JsonObject | undefined) };
    // Always enforce protocol fields while allowing caller-supplied traceparent/progressToken in params._meta.
    meta[META_PROTOCOL_VERSION] = coreMeta[META_PROTOCOL_VERSION];
    meta[META_CLIENT_CAPABILITIES] = coreMeta[META_CLIENT_CAPABILITIES];
    meta[META_CLIENT_INFO] = coreMeta[META_CLIENT_INFO];
    if (logLevel !== undefined) meta[META_LOG_LEVEL] = logLevel;
    requestParams._meta = meta;
    return { jsonrpc: "2.0", id, method, params: requestParams };
  }

  async function defaultTransport(): Promise<Mcp2026Transport> {
    if (config.transport === "stdio") {
      return createStdioTransport(config, { cwd: deps.cwd, resolveValue: resolveConfigValueAsync });
    }
    return createHttpTransport(config, {
      auth: deps.auth ?? noAuth,
      resolveValue: resolveConfigValueAsync,
    });
  }

  function transportClosed(transport: Mcp2026Transport): void {
    if (closed || currentTransport !== transport) return;
    removeCloseListener?.();
    removeCloseListener = undefined;
    if (transport.kind === "stdio") {
      currentTransport = undefined;
      transportPromise = undefined;
    }
    // Process/SSE death also terminates any listen attempts on that transport.
    const oldActive = active;
    const oldPending = pending;
    if (oldActive?.transport === transport) streamFinished(oldActive, undefined);
    if (oldPending?.transport === transport) streamFinished(oldPending, undefined);
  }

  function getTransport(): Promise<Mcp2026Transport> {
    if (closed) return Promise.reject(new McpTransportError("closed", "MCP client is closed"));
    if (transportPromise) return transportPromise;
    const created = (deps.createTransport?.(config) ?? defaultTransport());
    const promise = created.then(transport => {
      if (closed) {
        void transport.close().catch(() => {});
        throw new McpTransportError("closed", "MCP client is closed");
      }
      currentTransport = transport;
      removeCloseListener = transport.onUnexpectedClose(() => transportClosed(transport));
      return transport;
    }).catch(error => {
      if (transportPromise === promise) {
        transportPromise = undefined;
        currentTransport = undefined;
      }
      throw error;
    });
    transportPromise = promise;
    return promise;
  }

  async function closeTransport(): Promise<void> {
    const transport = currentTransport ?? await transportPromise?.catch(() => undefined);
    removeCloseListener?.();
    removeCloseListener = undefined;
    currentTransport = undefined;
    transportPromise = undefined;
    await transport?.close();
  }

  function forwardLogNotification(
    msg: JSONRPCNotification,
    onLog?: (entry: McpLogMessage) => void,
  ): void {
    if (msg.method !== "notifications/message") return;
    const params = msg.params;
    const rawLevel = typeof params?.level === "string" ? params.level : "info";
    const mcpLevel: McpLogLevel = (
      rawLevel === "debug"
      || rawLevel === "info"
      || rawLevel === "notice"
      || rawLevel === "warning"
      || rawLevel === "error"
      || rawLevel === "critical"
      || rawLevel === "alert"
      || rawLevel === "emergency"
    ) ? rawLevel : "info";
    const level: "info" | "warn" | "error" = mcpLevel === "warning"
      ? "warn"
      : mcpLevel === "error" || mcpLevel === "critical" || mcpLevel === "alert" || mcpLevel === "emergency"
        ? "error"
        : "info";
    const loggerName = typeof params?.logger === "string" && params.logger ? params.logger : undefined;
    const logger = loggerName ? `/${loggerName}` : "";
    const data = params?.data;
    const text = typeof data === "string" ? data : JSON.stringify(data ?? params ?? {});
    log(level, `[${config.name}${logger}] ${text}`);
    onLog?.({
      level: mcpLevel,
      ...(loggerName ? { logger: loggerName } : {}),
      data: data ?? params ?? {},
    });
  }

  function wrapRequestNotifications(
    userHandler?: (msg: JSONRPCNotification) => void,
    onLog?: (entry: McpLogMessage) => void,
  ): (msg: JSONRPCNotification) => void {
    return (msg: JSONRPCNotification) => {
      forwardLogNotification(msg, onLog);
      userHandler?.(msg);
    };
  }

  const toolHeaders = new Map<string, HeaderDescriptor[]>();
  let toolHeaderListing: Promise<void> | undefined;

  function recordToolsPage(tools: unknown): void {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      if (typeof tool !== "object" || tool === null) continue;
      const name = (tool as JsonObject).name;
      if (typeof name !== "string") continue;
      const validated = validateXMcpHeaders((tool as JsonObject).inputSchema);
      if (validated.valid) {
        toolHeaders.set(name, validated.headers);
      } else {
        toolHeaders.delete(name);
        log("warn", `[${config.name}] Ignoring invalid x-mcp-header on tool "${name}": ${validated.reason}`);
      }
    }
  }

  async function rawRequest<T = JsonObject>(
    method: string,
    params?: JsonObject,
    opts?: ClientRequestOptions,
  ): Promise<T> {
    clearIdleParkTimer();
    inFlightCount += 1;
    try {
      const transport = await getTransport();
      const response = await transport.request(
        requestMessage(method, params, nextId("request"), opts?.logLevel),
        {
          signal: opts?.signal,
          timeoutMs: opts?.timeoutMs ?? config.timeoutMs,
          onNotification: wrapRequestNotifications(opts?.onNotification, opts?.onLog),
          headers: opts?.headers,
        },
      );
      if (isErrorResponse(response)) throw new McpRpcError(response.error);
      const resObj = response.result;
      if (typeof resObj === "object" && resObj !== null && !Array.isArray(resObj)) {
        const rt = (resObj as JsonObject).resultType;
        if (
          rt !== undefined
          && rt !== "complete"
          && rt !== "input_required"
          && !(rt === "task" && method === "tools/call")
        ) {
          throw new McpTransportError(
            "protocol",
            `Unexpected MCP resultType "${String(rt)}" for method "${method}"`,
          );
        }
        if (method === "tools/list") {
          recordToolsPage((resObj as JsonObject).tools);
        }
      }
      return resObj as T;
    } finally {
      inFlightCount -= 1;
      scheduleIdleStdioParkIfEligible();
    }
  }

  async function cacheToolHeaders(): Promise<void> {
    if (toolHeaderListing) return toolHeaderListing;
    toolHeaderListing = (async () => {
      toolHeaders.clear();
      // rawRequest records each tools/list page's x-mcp-header descriptors as it arrives.
      await paginateMcp({ name: config.name, request: rawRequest }, "tools/list", () => []);
    })().finally(() => {
      toolHeaderListing = undefined;
    });
    return toolHeaderListing;
  }

  async function headersForCachedTool(
    method: string,
    params: JsonObject | undefined,
    supplied: Record<string, string> | undefined,
  ): Promise<Record<string, string> | undefined> {
    if (config.transport !== "http" || method !== "tools/call" || typeof params?.name !== "string") return supplied;
    const descriptors = toolHeaders.get(params.name);
    if (!descriptors) return supplied;
    const args = typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {};
    return { ...supplied, ...paramHeaders(descriptors, args) };
  }

  async function requestOnce<T = JsonObject>(
    method: string,
    params?: JsonObject,
    opts?: ClientRequestOptions,
  ): Promise<T> {
    const headers = await headersForCachedTool(method, params, opts?.headers);
    try {
      return await rawRequest<T>(method, params, { ...opts, headers });
    } catch (error) {
      if (config.transport !== "http" || method !== "tools/call"
        || !(error instanceof McpRpcError) || error.code !== ErrorCode.HeaderMismatch) throw error;
      await cacheToolHeaders();
      const descriptors = typeof params?.name === "string" ? toolHeaders.get(params.name) ?? [] : [];
      const args = typeof params?.arguments === "object" && params.arguments !== null ? params.arguments : {};
      const retryHeaders = { ...opts?.headers, ...paramHeaders(descriptors, args) };
      return rawRequest<T>(method, params, { ...opts, headers: retryHeaders });
    }
  }

  const MRTR_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

  async function request<T = JsonObject>(
    method: string,
    params?: JsonObject,
    opts?: ClientRequestOptions,
  ): Promise<T> {
    const baseParams: JsonObject = { ...params };
    let currentParams: JsonObject | undefined = params;
    for (let round = 0; round <= MAX_MRTR_ROUNDS; round += 1) {
      const result = await requestOnce<T>(method, currentParams, opts);
      const asObj = typeof result === "object" && result !== null ? (result as unknown as JsonObject) : undefined;
      if (asObj?.resultType !== "input_required") {
        return result;
      }
      if (!MRTR_METHODS.has(method)) {
        throw new McpTransportError("protocol", `Method "${method}" cannot return resultType: "input_required"`);
      }
      if (!deps.fulfillInputRequests) {
        return result;
      }
      const rawRequests = asObj.inputRequests;
      if (typeof rawRequests !== "object" || rawRequests === null || Array.isArray(rawRequests)) {
        throw new McpTransportError("protocol", "Invalid inputRequests in input_required result");
      }
      const entries = Object.entries(rawRequests as Record<string, unknown>);
      if (entries.length === 0) {
        throw new McpTransportError("protocol", "Empty inputRequests in input_required result");
      }
      const validatedReqs: Record<string, { method: string; params?: JsonObject }> = {};
      for (const [reqKey, val] of entries) {
        if (typeof val !== "object" || val === null || typeof (val as JsonObject).method !== "string") {
          throw new McpTransportError("protocol", `Invalid inputRequest entry "${reqKey}"`);
        }
        validatedReqs[reqKey] = {
          method: (val as JsonObject).method as string,
          params: typeof (val as JsonObject).params === "object" && (val as JsonObject).params !== null
            ? ((val as JsonObject).params as JsonObject)
            : undefined,
        };
      }
      const inputResponses = await deps.fulfillInputRequests(config.name, validatedReqs);
      if (!inputResponses) {
        throw new Error(`MCP server "${config.name}" requested client input that could not be fulfilled`);
      }
      currentParams = {
        ...baseParams,
        inputResponses,
        ...(asObj.requestState !== undefined ? { requestState: asObj.requestState } : {}),
      };
    }
    throw new McpTransportError("protocol", `Exceeded maximum MRTR input_required rounds (${MAX_MRTR_ROUNDS})`);
  }

  function clearCapabilities(): void {
    listenUnsupported = false;
    state.error = undefined;
    state.supportedVersions = undefined;
    state.events = false;
    state.eventsListChanged = false;
    state.tasks = false;
    state.tools = false;
    state.toolsListChanged = false;
    state.resources = false;
    state.resourcesSubscribe = false;
    state.resourcesListChanged = false;
    state.prompts = false;
    state.promptsListChanged = false;
    state.completions = false;
    state.skills = false;
    state.skillsDirectoryRead = false;
    state.serverInfo = undefined;
    state.instructions = undefined;
  }

  async function classifyDormant(era: "legacy" | "modern-dormant" | "unsupported-modern-version"): Promise<void> {
    state.era = era;
    await closeTransport().catch(() => {});
  }

  async function discover(): Promise<ServerState> {
    if (closed || !config.enabled) return state;
    state.era = "probing";
    clearCapabilities();
    try {
      const transport = await getTransport();
      const timeoutMs = Math.min(config.timeoutMs, transport.kind === "stdio" ? 5_000 : 10_000);
      const response = await transport.request(requestMessage("server/discover"), { timeoutMs });
      if (isErrorResponse(response)) {
        const code = response.error.code;
        if (!isModernError(code)) {
          await classifyDormant("legacy");
          return state;
        }
        if (code === ErrorCode.UnsupportedProtocolVersion) {
          const supported = supportedVersions(response.error.data);
          state.supportedVersions = supported;
          if (!supported?.includes(PROTOCOL_VERSION)) {
            await classifyDormant("unsupported-modern-version");
            return state;
          }
        }
        state.era = "modern";
        return state;
      }

      const result = response.result;
      if (!isDiscoverResult(result)) {
        await classifyDormant("legacy");
        return state;
      }
      state.supportedVersions = result.supportedVersions;
      if (!result.supportedVersions.includes(PROTOCOL_VERSION)) {
        await classifyDormant("unsupported-modern-version");
        return state;
      }
      const extensions = result.capabilities?.extensions;
      const eventsExtension = extensions?.[EXT_EVENTS];
      const tasksExtension = extensions?.[EXT_TASKS];
      const skillsExtension = extensions?.[EXT_SKILLS];
      const toolsCap: unknown = result.capabilities?.tools;
      const resourcesCap: unknown = result.capabilities?.resources;
      const promptsCap: unknown = result.capabilities?.prompts;
      const completionsCap: unknown = result.capabilities?.completions;

      state.events = eventsExtension !== undefined && eventsExtension !== false && eventsExtension !== null;
      state.tasks = tasksExtension !== undefined && tasksExtension !== false && tasksExtension !== null;
      state.eventsListChanged = typeof eventsExtension === "object" && eventsExtension !== null
        && (eventsExtension as JsonObject).listChanged === true;

      state.tools = toolsCap !== undefined && toolsCap !== false && toolsCap !== null;
      state.toolsListChanged = typeof toolsCap === "object" && toolsCap !== null
        && (toolsCap as JsonObject).listChanged === true;

      state.resources = resourcesCap !== undefined && resourcesCap !== false && resourcesCap !== null;
      state.resourcesSubscribe = typeof resourcesCap === "object" && resourcesCap !== null
        && (resourcesCap as JsonObject).subscribe === true;
      state.resourcesListChanged = typeof resourcesCap === "object" && resourcesCap !== null
        && (resourcesCap as JsonObject).listChanged === true;

      state.prompts = promptsCap !== undefined && promptsCap !== false && promptsCap !== null;
      state.promptsListChanged = typeof promptsCap === "object" && promptsCap !== null
        && (promptsCap as JsonObject).listChanged === true;

      state.completions = completionsCap !== undefined && completionsCap !== false && completionsCap !== null;

      const hasSkillsExt = skillsExtension !== undefined && skillsExtension !== false && skillsExtension !== null;
      state.skills = Boolean(state.resources && hasSkillsExt);
      state.skillsDirectoryRead = Boolean(
        state.skills
          && typeof skillsExtension === "object"
          && skillsExtension !== null
          && (skillsExtension as JsonObject).directoryRead === true,
      );

      state.serverInfo = result._meta?.[META_SERVER_INFO] as Implementation | undefined;
      state.instructions = result.instructions;
      const hasAnyModernSurface =
        state.events ||
        state.tasks ||
        state.skills ||
        state.prompts ||
        state.completions ||
        state.tools ||
        state.resources;
      if (!hasAnyModernSurface) await classifyDormant("modern-dormant");
      else state.era = "modern";
      return state;
    } catch (error) {
      if (error instanceof McpTransportError) {
        if (error.kind === "needs-auth") {
          state.era = "needs-auth";
          state.error = error.message;
        } else if (error.kind === "timeout" || error.kind === "closed" || error.kind === "interrupted"
          || (error.kind === "http" && (error.status === 400 || error.status === 404 || error.status === 405))) {
          await classifyDormant("legacy");
        } else {
          state.era = "error";
          state.error = error.message;
          log("error", error.message);
        }
      } else {
        state.era = "error";
        state.error = errorMessage(error);
        log("error", state.error);
      }
      return state;
    }
  }

  function emitListenState(honored: ListenFilter | undefined): void {
    for (const listener of [...stateListeners]) listener(honored);
  }

  function clearReconnect(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  function scheduleReconnect(): void {
    if (closed || listenUnsupported || reconnectTimer || desiredKey === "{}" || pending || active) return;
    const delay = nextBackoff;
    nextBackoff = Math.min(maxBackoff, Math.max(baseBackoff, nextBackoff * 2));
    const jittered = Math.max(0, Math.round(delay * (0.8 + Math.random() * 0.4)));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (!closed && !listenUnsupported && desiredKey !== "{}" && !active && !pending) startAttempt(desired, desiredKey);
    }, jittered);
    backgroundTimer(reconnectTimer);
  }

  function clearAckTimer(attempt: ListenAttempt | undefined): void {
    if (attempt?.ackTimer) {
      clearTimeout(attempt.ackTimer);
      attempt.ackTimer = undefined;
    }
  }

  function cancelAttempt(attempt: ListenAttempt | undefined, reason: string): void {
    if (!attempt) return;
    attempt.retired = true;
    clearAckTimer(attempt);
    if (attempt.handle && !attempt.cancelSent) {
      attempt.cancelSent = true;
      void attempt.handle.cancel(reason).catch(() => {});
    }
  }

  function dropActive(attempt: ListenAttempt, notify = true): void {
    if (active !== attempt) return;
    active = undefined;
    clearAckTimer(attempt);
    if (notify && attempt.acknowledged) emitListenState(undefined);
  }

  function streamFinished(attempt: ListenAttempt, _result: JSONRPCResultResponse | undefined): void {
    clearAckTimer(attempt);
    if (attempt.finished || attempt.retired) return;
    attempt.finished = true;
    if (pending === attempt) {
      pending = undefined;
      // A failed replacement retires the old stream only after the replacement has failed.
      const old = active;
      if (old) {
        dropActive(old);
        cancelAttempt(old, "listen replacement failed");
      }
      scheduleReconnect();
      return;
    }
    if (active === attempt) {
      dropActive(attempt);
      // An already-open replacement is the reconnect; otherwise back off and reopen.
      if (!pending) scheduleReconnect();
    }
  }

  function listenNotification(attempt: ListenAttempt, msg: JSONRPCNotification): void {
    if (attempt.retired || attempt.finished || subscriptionIdOf(msg) !== attempt.id) return;
    if (!attempt.acknowledged) {
      if (msg.method !== "notifications/subscriptions/acknowledged") return;
      attempt.acknowledged = true;
      clearAckTimer(attempt);
      nextBackoff = baseBackoff;
      const honored = normalizeFilter((msg.params?.notifications as ListenFilter | undefined) ?? {});
      if (pending === attempt) {
        pending = undefined;
        const old = active;
        active = attempt;
        emitListenState(honored);
        if (old && old !== attempt) {
          dropActive(old, false);
          cancelAttempt(old, "listen filter replaced");
        }
      } else if (active === attempt) {
        emitListenState(honored);
      }
      return;
    }
    if (msg.method === "notifications/subscriptions/acknowledged") return;
    for (const listener of [...notificationListeners]) listener(msg);
  }

  function startAttempt(filter: ListenFilter, key: string): void {
    if (closed || listenUnsupported || key === "{}") return;
    const attempt: ListenAttempt = {
      id: nextId("listen"),
      filter: { ...filter, taskIds: filter.taskIds ? [...filter.taskIds] : undefined },
      key,
      acknowledged: false,
      retired: false,
      finished: false,
      cancelSent: false,
    };
    pending = attempt;
    attempt.ackTimer = setTimeout(() => {
      attempt.ackTimer = undefined;
      if (!attempt.acknowledged && !attempt.retired && !attempt.finished) {
        cancelAttempt(attempt, "listen acknowledgment timeout");
        attempt.retired = false;
        streamFinished(attempt, undefined);
      }
    }, listenAckTimeoutMs);
    backgroundTimer(attempt.ackTimer);
    void (async () => {
      try {
        const transport = await getTransport();
        attempt.transport = transport;
        if (attempt.retired || closed || pending !== attempt || desiredKey !== key) return;
        const handle = await transport.openStream(
          requestMessage("subscriptions/listen", { notifications: attempt.filter }, attempt.id),
          msg => listenNotification(attempt, msg),
        );
        attempt.handle = handle;
        if (attempt.retired || closed || (pending !== attempt && active !== attempt)) {
          cancelAttempt(attempt, "listen filter superseded");
          return;
        }
        void handle.done.then(
          result => streamFinished(attempt, result),
          err => {
            if (isPermanentListenError(err)) {
              listenUnsupported = true;
              log("info", `[${config.name}] subscriptions/listen unsupported (${errorMessage(err)}); falling back`);
            }
            streamFinished(attempt, undefined);
          },
        );
      } catch (err) {
        if (isPermanentListenError(err)) {
          listenUnsupported = true;
          log("info", `[${config.name}] subscriptions/listen unsupported (${errorMessage(err)}); falling back`);
        }
        streamFinished(attempt, undefined);
      }
    })();
  }

  function unionFilters(): ListenFilter {
    let eventsListChanged = false;
    let toolsListChanged = false;
    let promptsListChanged = false;
    let resourcesListChanged = false;
    const taskIds: string[] = [];
    const seenTasks = new Set<string>();
    const resourceSubscriptions: string[] = [];
    const seenResources = new Set<string>();
    for (const filter of owners.values()) {
      eventsListChanged ||= filter.eventsListChanged === true;
      toolsListChanged ||= filter.toolsListChanged === true;
      promptsListChanged ||= filter.promptsListChanged === true;
      resourcesListChanged ||= filter.resourcesListChanged === true;
      for (const taskId of filter.taskIds ?? []) {
        if (!seenTasks.has(taskId)) {
          seenTasks.add(taskId);
          taskIds.push(taskId);
        }
      }
      for (const uri of filter.resourceSubscriptions ?? []) {
        if (!seenResources.has(uri)) {
          seenResources.add(uri);
          resourceSubscriptions.push(uri);
        }
      }
    }
    return normalizeFilter({
      eventsListChanged,
      taskIds,
      toolsListChanged,
      promptsListChanged,
      resourcesListChanged,
      resourceSubscriptions,
    });
  }

  function setListenInterest(owner: ListenOwner, filter: ListenFilter): void {
    if (closed) return;
    const normalized = normalizeFilter(filter);
    const previous = owners.get(owner);
    if (JSON.stringify(previous ?? {}) === JSON.stringify(normalized)) return;
    owners.set(owner, normalized);
    const union = unionFilters();
    const key = JSON.stringify(union);
    if (key === desiredKey) return;
    desired = union;
    desiredKey = key;
    clearReconnect();
    if (key === "{}") {
      const hadAcknowledged = active?.acknowledged === true || pending?.acknowledged === true;
      const oldActive = active;
      const oldPending = pending;
      active = undefined;
      pending = undefined;
      cancelAttempt(oldActive, "listen filter empty");
      cancelAttempt(oldPending, "listen filter empty");
      if (hadAcknowledged) emitListenState(undefined);
      return;
    }
    if (pending) {
      const obsolete = pending;
      pending = undefined;
      cancelAttempt(obsolete, "listen filter superseded");
    }
    startAttempt(union, key);
  }

  async function openStream(
    method: string,
    params: JsonObject,
    onNotification: (msg: JSONRPCNotification) => void,
    opts?: {
      signal?: AbortSignal;
      headers?: Record<string, string>;
      logLevel?: McpLogLevel;
      onLog?: (entry: McpLogMessage) => void;
    },
  ): Promise<OpenStreamHandle> {
    clearIdleParkTimer();
    openUserStreams += 1;
    try {
      const transport = await getTransport();
      const handle = await transport.openStream(
        requestMessage(method, params, nextId("request"), opts?.logLevel),
        wrapRequestNotifications(onNotification, opts?.onLog),
        opts,
      );
      void handle.done.then(
        () => {
          openUserStreams = Math.max(0, openUserStreams - 1);
          scheduleIdleStdioParkIfEligible();
        },
        () => {
          openUserStreams = Math.max(0, openUserStreams - 1);
          scheduleIdleStdioParkIfEligible();
        },
      );
      return handle;
    } catch (err) {
      openUserStreams = Math.max(0, openUserStreams - 1);
      scheduleIdleStdioParkIfEligible();
      throw err;
    }
  }

  async function park(): Promise<void> {
    clearIdleParkTimer();
    if (closed || inFlightCount > 0 || openUserStreams > 0 || desiredKey !== "{}" || active || pending) return;
    await closeTransport().catch(() => {});
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    clearIdleParkTimer();
    clearReconnect();
    const hadAcknowledged = active?.acknowledged === true || pending?.acknowledged === true;
    const attempts = [active, pending].filter(attempt => attempt !== undefined);
    active = undefined;
    pending = undefined;
    for (const attempt of attempts) cancelAttempt(attempt, "MCP client closed");
    if (hadAcknowledged) emitListenState(undefined);
    closePromise = closeTransport().catch(error => {
      log("warn", errorMessage(error));
    });
    return closePromise;
  }

  return {
    name: config.name,
    config,
    state,
    discover,
    request,
    openStream,
    setListenInterest,
    onListenNotification(listener) {
      notificationListeners.add(listener);
      return () => { notificationListeners.delete(listener); };
    },
    onListenState(listener) {
      stateListeners.add(listener);
      return () => { stateListeners.delete(listener); };
    },
    park,
    close,
  };
}
