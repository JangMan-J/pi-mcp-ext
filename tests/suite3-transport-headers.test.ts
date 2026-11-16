import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerClient } from '../src/client.ts';
import { createHttpTransport, encodeHeaderValue } from '../src/transport-http.ts';
import { McpTransportError, META_PROTOCOL_VERSION } from '../src/types.ts';
import type { ResolvedHttpServer } from '../src/types.ts';
// @ts-expect-error Shared native HTTP fixture is JavaScript.
import { startHttpServer } from './fixtures/http-server.mjs';

const auth = { async authorization(){return undefined;}, async refreshAfterUnauthorized(){return false;} };
test('Transport & Header Compliance Check: real POST, SSE, header recovery, retry and auth', async () => {
  let calls=0, polls=0;
  const server = await startHttpServer((r: any) => {
    const {id,method}=r.body;
    if(method==='tools/list') return {jsonrpc:'2.0',id,result:{tools:[{name:'tool',inputSchema:{type:'object',properties:{region:{type:'string','x-mcp-header':'Region'}}}}]}};
    if(method==='tools/call') {
      calls++;
      if(calls===1) return {status:400,json:{jsonrpc:'2.0',id,error:{code:-32020,message:'HeaderMismatch'}}};
      if(r.body.params.name==='fail') return {status:503,json:{error:'offline'}};
    }
    if(method==='events/list') return {status:401,json:{error:'unauthorized'}};
    if(method==='events/poll' && polls++===0) return {status:503,json:{error:'offline'}};
    return {sse:[':keepalive\r\n\r\n',`data: ${JSON.stringify({jsonrpc:'2.0',id,result:{ok:true}})}\r\n\r\n`]};
  });
  const config: ResolvedHttpServer={name:'mcp',namespace:'mcp__mcp',scope:'session',enabled:true,transport:'http',url:server.url,headers:{},timeoutMs:1000};
  const client=createServerClient(config,{cwd:process.cwd(),auth,createTransport:async()=>createHttpTransport(config,{auth})});
  try {
    for(const method of ['tasks/get','tasks/update','tasks/cancel']) await client.request(method,{taskId:'task'});
    for(const name of ['event','é',' leading','=?base64?abc?=']) for(const method of ['events/poll','events/stream']) await client.request(method,{name});
    await client.request('tools/call',{name:'tool',arguments:{region:'é'}});
    assert.equal(calls,2);
    assert.equal(server.requests.findLast((r:any)=>r.body.method==='tools/call').headers['mcp-param-region'],'=?base64?w6k=?=');
    const before=server.requests.length;
    await assert.rejects(client.request('tools/call',{name:'fail'}),(e:unknown)=>e instanceof McpTransportError && e.status===503);
    assert.equal(server.requests.length,before+1);
    await assert.rejects(client.request('events/list'),(e:unknown)=>e instanceof McpTransportError && e.kind==='needs-auth');
    const pollRequests=server.requests.filter((r:any)=>r.body.method==='events/poll');
    assert.notEqual(pollRequests[0].body.id,pollRequests[1].body.id);
    for(const r of server.requests) {
      assert.equal(r.method,'POST');
      assert.equal(r.headers['mcp-protocol-version'],'2026-07-28');
      assert.equal(r.headers['mcp-protocol-version'],r.body.params._meta[META_PROTOCOL_VERSION]);
      assert.equal(r.headers['mcp-method'],r.body.method);
      assert.equal(r.headers['mcp-session-id'],undefined); assert.equal(r.headers['last-event-id'],undefined);
      const source=r.body.params.taskId ?? r.body.params.name;
      assert.equal(r.headers['mcp-name'],source===undefined?undefined:encodeHeaderValue(source));
      if(source==='é') assert.equal(r.headers['mcp-name'],'=?base64?w6k=?=');
      if(source===' leading') assert.equal(r.headers['mcp-name'],'=?base64?IGxlYWRpbmc=?=');
      if(source==='=?base64?abc?=') assert.equal(r.headers['mcp-name'],'=?base64?PT9iYXNlNjQ/YWJjPz0=?=');
    }
  } finally {await client.close();await server.close();}
});
