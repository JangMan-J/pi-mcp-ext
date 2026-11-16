import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const record = { pid: process.pid, initialize: false, methods: [] };
const save = () => writeFileSync(process.env.MCP_RECORD, JSON.stringify(record));
save();
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  record.methods.push(request.method);
  if (request.method === 'initialize') record.initialize = true;
  save();
  if (!('id' in request)) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...JSON.parse(process.env.MCP_REPLY) }) + '\n');
});
