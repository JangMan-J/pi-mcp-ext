import { backgroundTimer } from "./timer.ts";
import { McpTransportError, McpRpcError, PROTOCOL_VERSION } from './types.ts';
import type { AuthResolver, ResolvedHttpServer, Mcp2026Transport, JSONRPCRequest, JSONRPCResponse, JSONRPCResultResponse, JSONRPCNotification, TransportRequestOptions } from './types.ts';

export function encodeHeaderValue(s: string): string {
  return /^[\t\x20-\x7e]*$/.test(s) && !/^[ \t]|[ \t]$/.test(s) && !/^=\?base64\?.*\?=$/s.test(s) ? s : `=?base64?${Buffer.from(s).toString('base64')}?=`;
}
export function headerString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v)) ? String(v) : undefined;
}
export function mcpNameFor(method: string, params: unknown): string | undefined {
  const p = params as Record<string, unknown> | undefined;
  const v = /^(tools\/call|prompts\/get|events\/(poll|stream))$/.test(method)
    ? p?.name
    : /^resources\/(read|directory\/read)$/.test(method)
      ? p?.uri
      : /^tasks\/(get|update|cancel)$/.test(method)
        ? p?.taskId
        : undefined;
  return typeof v === 'string' ? v : undefined;
}
export interface XMcpHeader { header: string; path: string[] }
const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function validateXMcpHeaders(inputSchema: unknown): {
  valid: boolean;
  headers: XMcpHeader[];
  reason?: string;
} {
  const headers: XMcpHeader[] = [];
  const seen = new Set<string>();
  let invalidReason: string | undefined;

  function checkDisallowedSubtree(node: unknown, context: string, ancestors: Set<object>): void {
    if (invalidReason || !node || typeof node !== 'object' || ancestors.has(node)) return;
    const nextAnc = new Set([...ancestors, node]);
    if (Array.isArray(node)) {
      for (const item of node) checkDisallowedSubtree(item, context, nextAnc);
      return;
    }
    const obj = node as Record<string, unknown>;
    if ('x-mcp-header' in obj) {
      invalidReason = `x-mcp-header is not permitted inside ${context}`;
      return;
    }
    for (const val of Object.values(obj)) {
      checkDisallowedSubtree(val, context, nextAnc);
    }
  }

  function walkStatic(value: unknown, path: string[], ancestors: Set<object>): void {
    if (invalidReason || !value || typeof value !== 'object' || Array.isArray(value) || ancestors.has(value)) return;
    const nextAnc = new Set([...ancestors, value]);
    const s = value as Record<string, unknown>;

    if (s.$ref !== undefined) {
      if ('x-mcp-header' in s) {
        invalidReason = 'x-mcp-header cannot be combined with $ref';
      }
      return;
    }

    if ('x-mcp-header' in s) {
      const h = s['x-mcp-header'];
      if (path.length === 0) {
        invalidReason = 'x-mcp-header is not permitted on root inputSchema';
        return;
      }
      if (typeof h !== 'string' || !HEADER_TOKEN_RE.test(h)) {
        invalidReason = `invalid x-mcp-header token "${String(h)}" at ${path.join('.')}`;
        return;
      }
      if (typeof s.type !== 'string' || !['string', 'integer', 'boolean'].includes(s.type)) {
        invalidReason = `x-mcp-header at ${path.join('.')} requires type string, integer, or boolean (got ${String(s.type)})`;
        return;
      }
      const lower = h.toLowerCase();
      if (seen.has(lower)) {
        invalidReason = `duplicate x-mcp-header name "${h}"`;
        return;
      }
      seen.add(lower);
      headers.push({ header: h, path });
    }

    for (const forbiddenKey of ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'items', 'prefixItems', 'additionalProperties', 'patternProperties', '$defs', 'definitions']) {
      if (s[forbiddenKey] !== undefined) {
        checkDisallowedSubtree(s[forbiddenKey], forbiddenKey, nextAnc);
        if (invalidReason) return;
      }
    }

    if (s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)) {
      if (s.type !== undefined && s.type !== 'object') {
        checkDisallowedSubtree(s.properties, 'non-object properties', nextAnc);
        return;
      }
      for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
        walkStatic(v, [...path, k], nextAnc);
        if (invalidReason) return;
      }
    }
  }

  walkStatic(inputSchema, [], new Set());
  return invalidReason ? { valid: false, headers: [], reason: invalidReason } : { valid: true, headers };
}

export function collectXMcpHeaders(inputSchema: unknown): XMcpHeader[] {
  const validated = validateXMcpHeaders(inputSchema);
  return validated.valid ? validated.headers : [];
}
export function paramHeaders(descriptors: XMcpHeader[], args: unknown): Record<string,string> {
  const out: Record<string,string> = {};
  for (const d of descriptors) {
    let v: any = args;
    for (const k of d.path) v = v && typeof v === 'object' && Object.hasOwn(v,k) ? v[k] : undefined;
    const s = headerString(v); if (s !== undefined) out[`Mcp-Param-${d.header}`] = encodeHeaderValue(s);
  }
  return out;
}

// Streaming comments become $/sse-comment notifications only for open streams, so the
// client's watchdog observes transport liveness without exposing comments as RPC data.
const MAX_SSE_BUFFER_CHARS = 32 * 1024 * 1024;
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', offset = 0, data: string[] = [];
  function line(s: string): unknown[] {
    if (s.startsWith(':')) return [{jsonrpc:'2.0',method:'$/sse-comment'}];
    if (s === '') { if (!data.length) return []; const v = JSON.parse(data.join('\n')); data = []; return [v]; }
    if (s.startsWith('data:')) data.push(s.slice(5).replace(/^ /,''));
    return [];
  }
  try {
    while (true) {
      const {value,done} = await reader.read(); buffer += done ? decoder.decode() : decoder.decode(value,{stream:true});
      while (offset < buffer.length) {
        let cr = buffer.indexOf('\r', offset), lf = buffer.indexOf('\n', offset);
        let nlIdx = cr === -1 ? lf : lf === -1 ? cr : Math.min(cr, lf);
        if (nlIdx === -1) break;
        if (!done && buffer[nlIdx] === '\r' && nlIdx === buffer.length - 1) break;
        const step = buffer[nlIdx] === '\r' && buffer[nlIdx + 1] === '\n' ? 2 : 1;
        const s = buffer.slice(offset, nlIdx);
        offset = nlIdx + step;
        for (const v of line(s)) yield v;
      }
      if (offset > 0) {
        if (offset === buffer.length) { buffer = ''; offset = 0; }
        else if (offset > 65536) { buffer = buffer.slice(offset); offset = 0; }
      }
      if (buffer.length - offset > MAX_SSE_BUFFER_CHARS) throw new Error('MCP SSE frame exceeded 32 MiB limit');
      if (done) {
        if (offset < buffer.length) {
          for (const v of line(buffer.slice(offset))) yield v;
        }
        break;
      }
    }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
export function createHttpTransport(server: ResolvedHttpServer, opts: { auth: AuthResolver; resolveValue?: (v:string)=>string | Promise<string>; fetch?: typeof fetch }): Mcp2026Transport {
  const active = new Set<AbortController>(), listeners = new Set<(err?:Error)=>void>();
  let closed = false, sequence = 0;
  const fail = (kind: ConstructorParameters<typeof McpTransportError>[0], message: string, status?:number) => new McpTransportError(kind,message,status);
  async function start(msg: JSONRPCRequest, options: TransportRequestOptions, stream: boolean) {
    if (closed) throw fail('closed','MCP transport is closed');
    const controller = new AbortController(); active.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const abort = () => controller.abort();
    const reset = () => { clearTimeout(timer); if (!stream && options.timeoutMs !== undefined) { timer = backgroundTimer(setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs)); } };
    options.signal?.addEventListener('abort',abort,{once:true}); if (options.signal?.aborted) abort(); reset();
    const cleanup = () => {clearTimeout(timer); active.delete(controller); options.signal?.removeEventListener('abort',abort);};
    const normalize = (e: unknown) => controller.signal.aborted ? fail(timedOut?'timeout':'aborted',timedOut?'MCP request timed out':'MCP request aborted') : e instanceof McpTransportError || e instanceof McpRpcError ? e : fail('network',String(e));
    try {
      let response: Response;
      for (let authAttempt=0;;authAttempt++) {
        const headers = new Headers();
        for (const [k,v] of Object.entries(server.headers)) {
          if (k.toLowerCase() === 'authorization') continue;
          headers.set(k, opts.resolveValue ? await opts.resolveValue(v) : v);
        }
        for (const [k,v] of Object.entries(options.headers ?? {})) headers.set(k,v);
        headers.delete('Mcp-Session-Id'); headers.delete('Last-Event-ID');
        headers.set('Content-Type','application/json'); headers.set('Accept','application/json, text/event-stream'); headers.set('MCP-Protocol-Version',PROTOCOL_VERSION); headers.set('Mcp-Method',msg.method);
        headers.delete('Mcp-Name'); const name=mcpNameFor(msg.method,msg.params); if(name!==undefined) headers.set('Mcp-Name',encodeHeaderValue(name));
        let auth = await opts.auth.authorization(controller.signal);
        if (auth === undefined) {
          const rawAuthHeader = Object.entries(server.headers).find(([k]) => k.toLowerCase() === 'authorization');
          if (rawAuthHeader) auth = opts.resolveValue ? await opts.resolveValue(rawAuthHeader[1]) : rawAuthHeader[1];
        }
        if(auth!==undefined) headers.set('Authorization',auth);
        response = await (opts.fetch ?? fetch)(server.url,{method:'POST',headers,body:JSON.stringify(msg),signal:controller.signal});
        if(response.status!==401) break;
        await response.body?.cancel().catch(()=>{});
        if(authAttempt===0 && await opts.auth.refreshAfterUnauthorized(controller.signal)) continue;
        throw fail('needs-auth',`MCP server "${server.name}" requires sign-in; run /mcp login ${server.name}`,401);
      }
      const json = response.headers.get('content-type')?.toLowerCase().includes('application/json');
      if(json) {
        let value: any; try { value=await response.json(); } catch { /* status checked below */ }
        if(value && value.id===msg.id && ('error' in value || 'result' in value)) {
          if(stream && 'error' in value) throw new McpRpcError(value.error);
          if(response.ok || 'error' in value) return {controller,cleanup,normalize,done:Promise.resolve(value as JSONRPCResponse)};
        }
        if(response.ok) throw fail('interrupted','Invalid MCP JSON response');
      }
      if(!response.ok) { await response.body?.cancel().catch(()=>{}); throw fail('http',`MCP HTTP ${response.status}`,response.status); }
      if(!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        await response.body?.cancel().catch(()=>{});
        throw fail('interrupted','Expected MCP response body');
      }
      const done = (async (): Promise<JSONRPCResponse | undefined> => {
        try {
          for await (const raw of frames(response.body!)) {
            const v = raw as any;
            if(v && v.id===msg.id && ('result' in v || 'error' in v)) { if(stream && 'error' in v) throw new McpRpcError(v.error); return v; }
            if(v && typeof v.method==='string' && !('id' in v)) {
              if(v.method==='notifications/progress') reset();
              if(stream || v.method!=='$/sse-comment') options.onNotification?.(v as JSONRPCNotification);
            }
          }
          if(!stream) throw fail('interrupted','MCP SSE ended before its response');
          return undefined;
        } catch(e) { throw normalize(e); } finally { cleanup(); }
      })();
      return {controller,cleanup,normalize,done};
    } catch(e) { cleanup(); throw normalize(e); }
  }
  return {
    kind:'http',
    async request(msg, options={}) {
      for(let attempt=0;;attempt++) {
        let entry: Awaited<ReturnType<typeof start>> | undefined;
        try { entry=await start(msg,options,false); return (await entry.done)!; }
        catch(e) {
          const err=e as McpTransportError;
          const retry=err.kind==='network' || err.kind==='interrupted' || (err.kind==='http' && (err.status===408 || err.status===429 || (err.status!>=500 && err.status!==501)));
          if(attempt || !['server/discover','events/list','events/poll','tasks/get'].includes(msg.method) || !retry || options.signal?.aborted || closed) throw e;
          await new Promise(r=>setTimeout(r,250)); msg={...msg,id:`http-retry-${++sequence}-${msg.id}`};
        } finally {entry?.cleanup();}
      }
    },
    async openStream(msg,onNotification,options={}) {
      const entry=await start(msg,{...options,onNotification},true);
      const done=entry.done.then(v=>v as JSONRPCResultResponse | undefined).finally(entry.cleanup);
      void done.catch(()=>{});
      return {requestId:msg.id,done,async cancel(){entry.controller.abort();await done.catch(()=>{});}};
    },
    onUnexpectedClose(listener){listeners.add(listener);return ()=>{listeners.delete(listener);};},
    async close(){closed=true;for(const c of active)c.abort();active.clear();},
  };
}
