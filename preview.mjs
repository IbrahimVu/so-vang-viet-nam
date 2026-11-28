import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { buildHistory } from './history.mjs';
import worker from './dist/server/index.js';

const port = Number(process.env.PORT || 4173);
let history;
createServer(async (req, res) => {
  try {
    if (req.url === '/history.json' && req.method === 'GET') {
      history ??= readFile('dist/pages/history.json').catch(async () => JSON.stringify(await buildHistory(Date.now())));
      const body = await history;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }).end(body);
      return;
    }
    const response = await worker.fetch(new Request(new URL(req.url, 'http://localhost:' + port)));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500).end();
  }
}).listen(port, '127.0.0.1', () => console.log('Local http://localhost:' + port));
