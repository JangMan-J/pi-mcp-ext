import test from 'node:test';
import assert from 'node:assert/strict';
import { createTasksEngine } from '../src/tasks.ts';
import { McpRpcError } from '../src/types.ts';
import type { ServerClient, EngineHost, ListenFilter, JSONRPCNotification } from '../src/types.ts';

function setup() {
  const calls: Array<[string,unknown]> = []; const wakes: string[] = [];
  let notify: (n:JSONRPCNotification)=>void = () => {}; let state: (f:ListenFilter|undefined)=>void = () => {};
  let interest: ListenFilter = {}; let snapshot: any = {taskId:'t',status:'working',createdAt:new Date().toISOString(),lastUpdatedAt:new Date().toISOString(),ttlMs:null,pollIntervalMs:10}; let error: unknown;
  const client = {
    name:'server', request: async (method:string,params:unknown) => { calls.push([method,params]); if (error) throw error; return method === 'tools/call' ? {...snapshot,resultType:'task'} : method === 'tasks/get' ? {...snapshot,resultType:'complete'} : {resultType:'complete'}; },
    setListenInterest: (_:string,f:ListenFilter) => { interest=f; },
    onListenNotification: (fn:typeof notify) => { notify=fn; return () => {}; },
    onListenState: (fn:typeof state) => { state=fn; return () => {}; },
  } as unknown as ServerClient;
  const host:EngineHost = {getClient:()=>client,appendEntry:()=>{},wake:(_,s)=>{wakes.push(s);},log:()=>{},signal:new AbortController().signal};
  const engine=createTasksEngine(host,{pollFloorMs:10,defaultPollMs:10});
  return {engine,calls,wakes,get interest(){return interest;},state:(f:ListenFilter|undefined)=>state(f),emit:()=>notify({jsonrpc:'2.0',method:'notifications/tasks',params:snapshot}),set:(s:object)=>{snapshot={...snapshot,...s};},fail:(e:unknown)=>{error=e;}};
}
test('fallback polling pauses on acknowledgment and resumes on drop', async t => {
  t.mock.timers.enable({apis:['setTimeout']}); const f=setup(); t.after(()=>f.engine.shutdown());
  await f.engine.call('server','tool',{}); assert.deepEqual(f.interest.taskIds,['t']);
  t.mock.timers.tick(10); await new Promise(setImmediate); assert.equal(f.calls.filter(c=>c[0]==='tasks/get').length,1);
  f.state({taskIds:['t']}); t.mock.timers.tick(100); await new Promise(setImmediate); assert.equal(f.calls.length,2);
  f.state(undefined); t.mock.timers.tick(0); await new Promise(setImmediate); assert.equal(f.calls.length,3);
});
test('input keys deduplicate, update explicitly, and tool errors remain completed',async t=>{
  const f=setup(); t.after(()=>f.engine.shutdown()); await f.engine.call('server','tool');
  f.set({status:'input_required',inputRequests:{a:{method:'roots/list'}}}); await f.engine.get('server','t'); await f.engine.get('server','t'); assert.equal(f.wakes.length,1); assert.match(f.wakes[0],/Untrusted/);
  await f.engine.update('server','t',{a:{roots:[]}}); assert.deepEqual(f.calls.at(-1),['tasks/update',{taskId:'t',inputResponses:{a:{roots:[]}}}]);
  await f.engine.get('server','t'); assert.equal(f.wakes.length,1);
  f.set({status:'completed',result:{content:[{type:'text',text:'bad'}],isError:true}}); f.emit(); f.emit(); assert.equal(f.wakes.length,2); assert.match(f.wakes[1],/Tool error.*status completed/); assert.deepEqual(f.interest.taskIds,[]);
});
test('failed JSON-RPC error and missing task each wake once',async t=>{
  const f=setup(); const g=setup(); t.after(async()=>{await f.engine.shutdown();await g.engine.shutdown();});
  await f.engine.call('server','tool'); f.set({status:'failed',error:{code:-32603,message:'failure'}}); f.emit(); assert.match(f.wakes[0],/JSON-RPC error.*-32603/);
  await g.engine.call('server','tool'); g.fail(new McpRpcError({code:-32602,message:'missing'})); await assert.rejects(g.engine.get('server','t')); await assert.rejects(g.engine.get('server','t')); assert.equal(g.engine.active()[0].status,'not_found_or_expired'); assert.equal(g.wakes.length,1);
});
test('cancel uses tasks/cancel and stops immediately',async t=>{
  const f=setup(); t.after(()=>f.engine.shutdown()); await f.engine.call('server','tool'); await f.engine.cancel('server','t'); assert.deepEqual(f.calls.map(c=>c[0]),['tools/call','tasks/cancel']); assert.equal(f.engine.hasPending(),false); assert.equal(f.wakes.length,0); assert.deepEqual(f.interest.taskIds,[]);
});
