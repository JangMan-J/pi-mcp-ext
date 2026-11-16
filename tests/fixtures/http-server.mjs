import { createServer } from 'node:http';

/** Handler receives the recorded request and native response. It may write directly,
 * or return {status, json}, {status, sse: [raw SSE chunks]}, or a JSON-RPC object. */
export async function startHttpServer(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const record = { method: req.method, headers: req.headers, body: text ? JSON.parse(text) : undefined };
      requests.push(record);
      const result = await handler(record, res, requests);
      if (res.writableEnded || result === undefined) return;
      res.statusCode = result.status ?? 200;
      if (result.sse) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
        for (const chunk of result.sse) res.write(chunk);
        res.end();
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result.json ?? result));
      }
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`, requests,
    async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); },
  };
}
