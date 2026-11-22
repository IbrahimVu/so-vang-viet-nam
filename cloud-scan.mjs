import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { scanSlot, scanWindowIsOpen } from './scan-window.mjs';
import { createSnapshotStore } from './cloud-storage.mjs';

export async function collectScheduledPrices({ scheduledAt, now = Date.now(), store, collect }) {
  if (!scheduledAt || !Number.isFinite(Date.parse(scheduledAt))) return 'invalid-schedule';
  const slot = scanSlot(Date.parse(scheduledAt));
  if (slot > now || !scanWindowIsOpen(slot) || !scanWindowIsOpen(now)) return 'outside-window';

  const saved = await store.read();
  if (Date.parse(saved?.snapshot?.scheduledAt) >= slot) return 'already-published';

  const quoteData = await collect();
  if (!quoteData.sources.some(source => source.status === 'ok' && source.rows.length > 0)) {
    throw new Error('All sources unavailable');
  }
  const prior = saved?.snapshot?.sources ?? [];
  const sources = quoteData.sources.map(source => {
    const previous = prior.find(item => item.id === source.id);
    return source.rows.length || !previous?.rows.length ? source :
      { ...source, status: 'cached', rows: previous.rows, checkedAt: previous.checkedAt };
  });
  const snapshot = { scheduledAt: new Date(slot).toISOString(), checkedAt: quoteData.checkedAt, sources };

  if (await store.write(snapshot, saved?.generation ?? '0')) return 'published';
  const latest = await store.read();
  if (Date.parse(latest?.snapshot?.scheduledAt) >= slot) return 'already-published';
  throw new Error('Snapshot changed during publication; retry the scan');
}

export async function snapshotHealth(store, now = Date.now()) {
  if (!scanWindowIsOpen(now) || !scanWindowIsOpen(now - 10 * 60_000)) return 'outside-monitoring-window';
  const saved = await store.read();
  return Date.parse(saved?.snapshot?.checkedAt) > now - 10 * 60_000 ? 'ok' : 'stale';
}

async function serve() {
  await import('./build.mjs');
  const { default: worker } = await import('./dist/server/index.js');
  const store = createSnapshotStore(process.env.GOLD_SNAPSHOT_BUCKET);
  const collect = async () => {
    const response = await worker.fetch(new Request('https://localhost/api/prices'), {
      BTMC_API_KEY: process.env.BTMC_API_KEY, readPublishedBtmcKey: true
    });
    return response.json();
  };
  createServer(async (request, response) => {
    const health = request.method === 'GET' && request.url === '/healthz';
    if (!health && (request.method !== 'POST' || request.url !== '/scan')) return response.writeHead(404).end();
    try {
      if (health) {
        const result = await snapshotHealth(store);
        console.info(JSON.stringify({ event: 'gold-price-health', result }));
        return response.writeHead(result === 'stale' ? 503 : 204).end();
      }
      const scheduledAt = request.headers['x-cloudscheduler-scheduletime'];
      const result = await collectScheduledPrices({ scheduledAt, store, collect });
      console.info(JSON.stringify({ event: 'gold-price-scan', scheduledAt, result }));
      response.writeHead(result === 'invalid-schedule' ? 400 : 204).end();
    } catch {
      console.error(JSON.stringify({ event: health ? 'gold-price-health' : 'gold-price-scan', result: 'failed' }));
      response.writeHead(503).end();
    }
  }).listen(Number(process.env.PORT || 8080), '0.0.0.0');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve();
