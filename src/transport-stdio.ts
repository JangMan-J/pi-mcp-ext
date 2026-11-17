import { backgroundTimer } from "./timer.ts";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  isErrorResponse,
  isNotification,
  isResponse,
  META_LOG_LEVEL,
  McpRpcError,
  McpTransportError,
  subscriptionIdOf,
} from "./types.ts";
import type {
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCResultResponse,
  Mcp2026Transport,
  OpenStreamHandle,
  RequestId,
  ResolvedStdioServer,
  TransportRequestOptions,
} from "./types.ts";

const STDERR_TAIL_LIMIT = 2_000;
const MAX_STDOUT_LINE_CHARS = 32 * 1024 * 1024;
const EOF_WAIT_MS = 150;
const SHUTDOWN_WAIT_MS = 1_500;
const SIGKILL_WAIT_MS = 500;
const EXIT_DRAIN_MS = 50;

interface PendingRequest {
  readonly id: RequestId;
  readonly progressToken: RequestId;
  readonly timeoutMs: number | undefined;
  readonly wantsLogNotifications: boolean;
  readonly onNotification: ((msg: JSONRPCNotification) => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanupAbort: (() => void) | undefined;
  resetTimer: () => void;
  resolve: (res: JSONRPCResponse) => void;
  reject: (err: McpTransportError) => void;
}

interface ActiveStream {
  readonly id: RequestId;
  readonly onNotification: (msg: JSONRPCNotification) => void;
  cleanupAbort: (() => void) | undefined;
  resolveDone: (res: JSONRPCResultResponse | undefined) => void;
  rejectDone: (err: Error) => void;
  settled: boolean;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function abortReasonText(signal: AbortSignal, fallback: string): string {
  const reason: unknown = signal.reason;
  if (typeof reason === "string" && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return fallback;
}

function extractProgressToken(msg: JSONRPCRequest): RequestId {
  const metaToken = msg.params?._meta?.["progressToken"];
  if (typeof metaToken === "string" || typeof metaToken === "number") return metaToken;
  const paramToken = msg.params?.["progressToken"];
  if (typeof paramToken === "string" || typeof paramToken === "number") return paramToken;
  return msg.id;
}

function waitOrTimeout(done: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolveWait) => {
    const timer = setTimeout(() => {
      resolveWait();
    }, ms);
    backgroundTimer(timer);
    void done.then(() => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct child kill when group signalling is unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process has already exited.
  }
}

export async function createStdioTransport(
  server: ResolvedStdioServer,
  opts: { cwd: string; resolveValue?: (v: string) => string | Promise<string> },
): Promise<Mcp2026Transport> {
  const resolveValue = opts.resolveValue ?? ((v: string) => v);
  const resolvedEnv: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(server.env)) {
    resolvedEnv[key] = await resolveValue(rawValue);
  }

  const command = expandHome(server.command);
  const args = server.args.map(expandHome);
  const cwd = resolve(opts.cwd, expandHome(server.cwd ?? "."));

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...resolvedEnv },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stderrTail = "";

  const requests = new Map<RequestId, PendingRequest>();
  const streams = new Map<RequestId, ActiveStream>();
  const unexpectedCloseListeners = new Set<(err?: Error) => void>();

  let closing = false;
  let childExited = false;
  let terminatedHandled = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: Error | undefined;
  let unexpectedExitError: Error | undefined;
  let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<void> | undefined;

  const exitWaiters = new Set<() => void>();
  let resolveChildExitedRaw!: () => void;
  const childExitedPromise = new Promise<void>((res) => {
    resolveChildExitedRaw = res;
  });
  function resolveChildExited(): void {
    resolveChildExitedRaw();
    if (exitWaiters.size > 0) {
      const waiters = [...exitWaiters];
      exitWaiters.clear();
      for (const waiter of waiters) waiter();
    }
  }

  function appendStderr(text: string): void {
    if (text.length === 0) return;
    stderrTail += text;
    if (stderrTail.length > STDERR_TAIL_LIMIT) {
      stderrTail = stderrTail.slice(-STDERR_TAIL_LIMIT);
      const first = stderrTail.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) {
        stderrTail = stderrTail.slice(1);
      }
    }
  }

  function formatWithStderr(prefix: string): string {
    const trimmed = stderrTail.trim();
    return trimmed.length > 0 ? `${prefix}: ${trimmed}` : prefix;
  }

  function closedErrorMessage(): string {
    if (closing) {
      return formatWithStderr(`MCP stdio server "${server.name}" closed`);
    }
    if (spawnError) {
      return formatWithStderr(`MCP stdio server "${server.name}" error: ${spawnError.message}`);
    }
    const detail =
      exitSignal !== null
        ? `signal ${exitSignal}`
        : exitCode !== null
          ? `code ${exitCode}`
          : "closed";
    return formatWithStderr(`MCP stdio server "${server.name}" exited (${detail})`);
  }

  function serializeFrame(msg: JSONRPCRequest | JSONRPCNotification): string {
    const json = JSON.stringify(msg);
    if (json === undefined || json.includes("\n") || json.includes("\r")) {
      throw new McpTransportError("protocol", "Serialized stdio JSON-RPC message must not contain raw CR or LF");
    }
    return `${json}\n`;
  }

  function writeFrame(msg: JSONRPCRequest | JSONRPCNotification): Promise<void> {
    if (closing || childExited || terminatedHandled || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new McpTransportError("closed", closedErrorMessage()));
    }
    let frame: string;
    try {
      frame = serializeFrame(msg);
    } catch (err) {
      return Promise.reject(
        err instanceof McpTransportError
          ? err
          : new McpTransportError("protocol", err instanceof Error ? err.message : String(err)),
      );
    }
    return new Promise<void>((resolveWrite, rejectWrite) => {
      let settled = false;
      const onExit = (): void => {
        if (settled) return;
        settled = true;
        exitWaiters.delete(onExit);
        rejectWrite(new McpTransportError("closed", closedErrorMessage()));
      };
      exitWaiters.add(onExit);
      if (childExited) {
        onExit();
        return;
      }
      child.stdin.write(frame, "utf8", (err) => {
        if (settled) return;
        settled = true;
        exitWaiters.delete(onExit);
        if (err) {
          rejectWrite(new McpTransportError("closed", formatWithStderr(`MCP stdio write failed: ${err.message}`)));
          return;
        }
        resolveWrite();
      });
    });
  }

  function sendCancelled(requestId: RequestId, reason?: string): Promise<void> {
    if (closing || childExited || terminatedHandled || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.resolve();
    }
    const params: Record<string, unknown> =
      reason !== undefined ? { requestId, reason } : { requestId };
    const notification: JSONRPCNotification = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params,
    };
    return writeFrame(notification).catch(() => {});
  }

  function findPendingByProgressToken(token: RequestId): PendingRequest | undefined {
    for (const entry of requests.values()) {
      if (entry.progressToken === token) return entry;
    }
    return undefined;
  }

  function handleMessage(msg: unknown): void {
    if (isResponse(msg)) {
      const id = msg.id;
      if (typeof id !== "string" && typeof id !== "number") return;

      const pending = requests.get(id);
      if (pending) {
        requests.delete(id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.cleanupAbort?.();
        pending.resolve(msg);
        return;
      }

      const stream = streams.get(id);
      if (stream && !stream.settled) {
        stream.settled = true;
        streams.delete(id);
        stream.cleanupAbort?.();
        if (isErrorResponse(msg)) {
          stream.rejectDone(new McpRpcError(msg.error));
        } else {
          stream.resolveDone(msg);
        }
      }
      return;
    }

    if (isNotification(msg)) {
      if (msg.method === "notifications/progress") {
        const token = msg.params?.["progressToken"];
        if (typeof token === "string" || typeof token === "number") {
          const pending = findPendingByProgressToken(token);
          if (pending) {
            pending.resetTimer();
            pending.onNotification?.(msg);
            return;
          }
        }
      }

      const subId = subscriptionIdOf(msg);
      if (subId !== undefined) {
        const stream = streams.get(subId);
        if (stream && !stream.settled) {
          stream.onNotification(msg);
        }
        return;
      }

      if (msg.method === "notifications/message") {
        const candidates: PendingRequest[] = [];
        for (const entry of requests.values()) {
          if (entry.wantsLogNotifications && entry.onNotification) {
            candidates.push(entry);
          }
        }
        if (candidates.length === 1) {
          candidates[0].onNotification?.(msg);
        }
      }
    }
  }

  function handleLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      return;
    }
    handleMessage(parsed);
  }

  let stdoutOffset = 0;

  function drainStdout(flush: boolean): void {
    let newlineIndex = stdoutBuffer.indexOf("\n", stdoutOffset);
    while (newlineIndex !== -1) {
      let line = stdoutBuffer.slice(stdoutOffset, newlineIndex);
      stdoutOffset = newlineIndex + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) {
        handleLine(line);
      }
      newlineIndex = stdoutBuffer.indexOf("\n", stdoutOffset);
    }
    if (stdoutOffset > 0) {
      if (stdoutOffset === stdoutBuffer.length) {
        stdoutBuffer = "";
        stdoutOffset = 0;
      } else if (stdoutOffset > 65_536) {
        stdoutBuffer = stdoutBuffer.slice(stdoutOffset);
        stdoutOffset = 0;
      }
    }
    if (!flush && stdoutBuffer.length - stdoutOffset > MAX_STDOUT_LINE_CHARS) {
      stdoutBuffer = "";
      stdoutOffset = 0;
      settleAllInFlight(
        new McpTransportError("protocol", `MCP stdio server "${server.name}" exceeded 32 MiB line limit`),
      );
      signalProcessGroup(child, "SIGTERM");
      return;
    }
    if (flush && stdoutOffset < stdoutBuffer.length) {
      let line = stdoutBuffer.slice(stdoutOffset);
      stdoutBuffer = "";
      stdoutOffset = 0;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) {
        handleLine(line);
      }
    }
  }

  function settleAllInFlight(err: McpTransportError): void {
    const pendingEntries = [...requests.values()];
    requests.clear();
    for (const entry of pendingEntries) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.cleanupAbort?.();
      entry.reject(err);
    }

    const activeStreams = [...streams.values()];
    streams.clear();
    for (const stream of activeStreams) {
      if (!stream.settled) {
        stream.settled = true;
        stream.cleanupAbort?.();
        stream.resolveDone(undefined);
      }
    }
  }

  function finalizeTermination(): void {
    if (terminatedHandled) return;
    terminatedHandled = true;
    if (exitDrainTimer !== undefined) {
      clearTimeout(exitDrainTimer);
      exitDrainTimer = undefined;
    }

    stdoutBuffer += stdoutDecoder.end();
    drainStdout(true);
    appendStderr(stderrDecoder.end());

    const err = new McpTransportError("closed", closedErrorMessage());
    settleAllInFlight(err);

    if (!closing) {
      unexpectedExitError = err;
      for (const listener of [...unexpectedCloseListeners]) {
        listener(err);
      }
    }
  }

  child.stdin.on("error", () => {
    // Handled per-write and on process exit.
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += stdoutDecoder.write(chunk);
    drainStdout(false);
  });

  child.stdout.on("end", () => {
    stdoutBuffer += stdoutDecoder.end();
    drainStdout(true);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    appendStderr(stderrDecoder.write(chunk));
  });

  child.stderr.on("end", () => {
    appendStderr(stderrDecoder.end());
  });

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    let settled = false;

    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      resolveSpawn();
    });

    child.on("error", (err: Error) => {
      spawnError = err;
      if (!settled) {
        settled = true;
        childExited = true;
        resolveChildExited();
        terminatedHandled = true;
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        rejectSpawn(
          new McpTransportError(
            "closed",
            formatWithStderr(`Failed to spawn MCP stdio server "${server.name}": ${err.message}`),
          ),
        );
        return;
      }
      if (!terminatedHandled) {
        finalizeTermination();
      }
    });

    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      childExited = true;
      resolveChildExited();
      if (!terminatedHandled && exitDrainTimer === undefined) {
        exitDrainTimer = setTimeout(() => {
          finalizeTermination();
        }, EXIT_DRAIN_MS);
        backgroundTimer(exitDrainTimer);
      }
    });

    child.once("close", (code, signal) => {
      if (exitCode === null) exitCode = code;
      if (exitSignal === null) exitSignal = signal;
      if (!childExited) {
        childExited = true;
        resolveChildExited();
      }
      finalizeTermination();
    });
  });

  return {
    kind: "stdio",

    request(msg: JSONRPCRequest, reqOpts?: TransportRequestOptions): Promise<JSONRPCResponse> {
      if (closing || childExited || terminatedHandled) {
        return Promise.reject(new McpTransportError("closed", closedErrorMessage()));
      }
      const signal = reqOpts?.signal;
      if (signal?.aborted) {
        return Promise.reject(new McpTransportError("aborted", abortReasonText(signal, "Request aborted")));
      }

      const timeoutMs = reqOpts?.timeoutMs;
      const progressToken = extractProgressToken(msg);
      const wantsLogNotifications = Boolean(msg.params?._meta?.[META_LOG_LEVEL]);

      return new Promise<JSONRPCResponse>((resolveReq, rejectReq) => {
        const entry: PendingRequest = {
          id: msg.id,
          progressToken,
          timeoutMs,
          wantsLogNotifications,
          onNotification: reqOpts?.onNotification,
          timer: undefined,
          cleanupAbort: undefined,
          resetTimer: () => {
            if (timeoutMs === undefined) return;
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
              if (!requests.delete(msg.id)) return;
              entry.cleanupAbort?.();
              const reason = `Request ${String(msg.id)} timed out after ${timeoutMs}ms`;
              void sendCancelled(msg.id, reason);
              rejectReq(new McpTransportError("timeout", formatWithStderr(reason)));
            }, timeoutMs);
            backgroundTimer(entry.timer);
          },
          resolve: resolveReq,
          reject: rejectReq,
        };

        if (signal) {
          const onAbort = (): void => {
            if (!requests.delete(msg.id)) return;
            if (entry.timer !== undefined) clearTimeout(entry.timer);
            const reason = abortReasonText(signal, "Request aborted");
            void sendCancelled(msg.id, reason);
            rejectReq(new McpTransportError("aborted", reason));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          entry.cleanupAbort = () => {
            signal.removeEventListener("abort", onAbort);
          };
        }

        entry.resetTimer();
        requests.set(msg.id, entry);

        void writeFrame(msg).catch((err: unknown) => {
          if (!requests.delete(msg.id)) return;
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          entry.cleanupAbort?.();
          rejectReq(
            err instanceof McpTransportError
              ? err
              : new McpTransportError("closed", err instanceof Error ? err.message : String(err)),
          );
        });
      });
    },

    async openStream(
      msg: JSONRPCRequest,
      onNotification: (msg: JSONRPCNotification) => void,
      streamOpts?: { signal?: AbortSignal; headers?: Record<string, string> },
    ): Promise<OpenStreamHandle> {
      if (closing || childExited || terminatedHandled) {
        throw new McpTransportError("closed", closedErrorMessage());
      }
      const signal = streamOpts?.signal;
      if (signal?.aborted) {
        throw new McpTransportError("aborted", abortReasonText(signal, "Stream aborted"));
      }

      let resolveDone!: (res: JSONRPCResultResponse | undefined) => void;
      let rejectDone!: (err: Error) => void;
      const done = new Promise<JSONRPCResultResponse | undefined>((res, rej) => {
        resolveDone = res;
        rejectDone = rej;
      });
      done.catch(() => {});

      const stream: ActiveStream = {
        id: msg.id,
        onNotification,
        cleanupAbort: undefined,
        resolveDone,
        rejectDone,
        settled: false,
      };

      const cancel = async (reason?: string): Promise<void> => {
        if (stream.settled) return;
        stream.settled = true;
        streams.delete(msg.id);
        stream.cleanupAbort?.();
        stream.resolveDone(undefined);
        await sendCancelled(msg.id, reason);
      };

      if (signal) {
        const onAbort = (): void => {
          void cancel(abortReasonText(signal, "Stream aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        stream.cleanupAbort = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }

      streams.set(msg.id, stream);

      try {
        await writeFrame(msg);
      } catch (err) {
        if (!stream.settled) {
          stream.settled = true;
          streams.delete(msg.id);
          stream.cleanupAbort?.();
          stream.resolveDone(undefined);
        }
        throw err instanceof McpTransportError
          ? err
          : new McpTransportError("closed", err instanceof Error ? err.message : String(err));
      }

      if (signal?.aborted) {
        const reason = abortReasonText(signal, "Stream aborted");
        await cancel(reason);
        throw new McpTransportError("aborted", reason);
      }

      return {
        requestId: msg.id,
        done,
        cancel,
      };
    },

    onUnexpectedClose(listener: (err?: Error) => void): () => void {
      let active = true;
      unexpectedCloseListeners.add(listener);
      if (unexpectedExitError !== undefined && !closing) {
        const err = unexpectedExitError;
        queueMicrotask(() => {
          if (active && !closing) {
            listener(err);
          }
        });
      }
      return () => {
        active = false;
        unexpectedCloseListeners.delete(listener);
      };
    },

    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;

      closePromise = (async () => {
        settleAllInFlight(new McpTransportError("closed", closedErrorMessage()));

        if (!childExited) {
          try {
            child.stdin.end();
          } catch {
            // Ignore stdin close errors.
          }
          await waitOrTimeout(childExitedPromise, EOF_WAIT_MS);
        }

        if (!childExited) {
          signalProcessGroup(child, "SIGTERM");
          await waitOrTimeout(childExitedPromise, SHUTDOWN_WAIT_MS);
        }

        if (!childExited) {
          signalProcessGroup(child, "SIGKILL");
          await waitOrTimeout(childExitedPromise, SIGKILL_WAIT_MS);
        }

        finalizeTermination();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      })();

      return closePromise;
    },
  };
}
