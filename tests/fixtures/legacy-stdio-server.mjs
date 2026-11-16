import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const record = { pid: process.pid, initialize: false, methods: [] };
const save = () => writeFileSync(process.env.MCP_RECORD, JSON.stringify(record));
save();
if (process.env.MCP_MODE === 'eof') process.exit(0);
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  record.methods.push(request.method);
  if (request.method === 'initialize') record.initialize = true;
  save();
  if (process.env.MCP_MODE === 'timeout' || !('id' in request)) return;
  const response = request.method === 'initialize'
    ? { result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'MCP', version: '1' } } }
    : { error: { code: -32601, message: 'Method not found' } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\n');
});
