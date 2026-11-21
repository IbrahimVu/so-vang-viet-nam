import { createServer } from 'node:http';
import worker from './dist/server/index.js';

const port = Number(process.env.PORT || 4173);
createServer(async (req, res) => {
  try {
    const response = await worker.fetch(new Request(new URL(req.url, 'http://localhost:' + port)));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500).end();
  }
}).listen(port, '127.0.0.1', () => console.log('Local http://localhost:' + port));
