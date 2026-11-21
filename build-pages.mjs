import { mkdir, readFile, writeFile } from 'node:fs/promises';
import './build.mjs';
import { readScanState, recordScan, scanIsPaused, workflowOutput } from './scan-state.mjs';

const { default: worker } = await import('./dist/server/index.js');
const liveOrigin = process.env.LIVE_PRICE_API_ORIGIN?.trim();
const liveEndpoint = liveOrigin && new URL('/api/prices', liveOrigin).href;
const isScheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
const previous = process.env.GITHUB_ACTIONS === 'true' ? (await readScanState())?.state : null;
const paused = scanIsPaused(previous);
if (isScheduled && paused) {
  console.log('Tạm dừng quét đến', previous.pausedUntil);
  await workflowOutput(false);
  process.exit(0);
}

async function fetchSnapshot() {
  const btmcDocs = 'https://btmc.vn/thong-tin/tai-lieu-api/api-gia-vang-17784.html';
  let btmcKey = process.env.BTMC_API_KEY;
  if (!btmcKey) {
    try {
      const docs = await fetch(btmcDocs, { redirect: 'error', signal: AbortSignal.timeout(6000) });
      if (docs.ok) btmcKey = (await docs.text()).match(/getpricebtmc\?key=([a-z0-9]{20,60})/i)?.[1];
    } catch {
      // The worker can still try BTMC's daily table.
    }
  }
  const response = await worker.fetch(new Request('https://localhost/api/prices'), { BTMC_API_KEY: btmcKey });
  const snapshot = await response.json();
  if (liveEndpoint && snapshot.sources.some(source => source.status !== 'ok')) {
    try {
      const response = await fetch(liveEndpoint, { signal: AbortSignal.timeout(12_000) });
      if (response.ok) {
        const supplemental = await response.json();
        snapshot.sources = snapshot.sources.map(source => source.status === 'ok' ? source :
          supplemental.sources.find(item => item.id === source.id && item.status === 'ok' && item.rows.length) ?? source);
      }
    } catch {
      // The scheduled build can still publish quotes fetched directly.
    }
  }
  if (!snapshot.sources.some(source => source.status === 'ok' && source.rows.length > 0)) {
    throw new Error('Không lấy được giá từ nguồn nào. Giữ bản Pages đã xuất bản trước đó.');
  }
  return snapshot;
}

async function publishedSnapshot() {
  const response = await fetch('https://ibrahimvu.github.io/so-vang-viet-nam/prices.json', {
    cache: 'no-store', signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error('Không đọc được bản giá đã xuất bản trong thời gian tạm dừng.');
  return response.json();
}

const snapshot = paused ? await publishedSnapshot() : await fetchSnapshot();
const next = isScheduled || !previous && process.env.GITHUB_ACTIONS === 'true' ?
  recordScan(previous, snapshot) : null;
snapshot.scan = { pausedUntil: next ? next.pausedUntil : paused ? previous.pausedUntil : null };

const connect = liveEndpoint ? ' ' + new URL(liveEndpoint).origin : '';
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'" +
  connect + "; base-uri 'none'; form-action 'none'";
const endpointAttributes = 'data-endpoint="./prices.json"' +
  (liveEndpoint ? ' data-live-endpoint="' + liveEndpoint + '"' : '');
const syncDescription = liveEndpoint ?
  'Quét mỗi 5 phút, tạm dừng sau 20 lần liên tiếp giá không đổi và quét lại lúc 08:30 giờ Việt Nam. Chọn Làm mới để lấy giá theo yêu cầu.' :
  'Quét mỗi 5 phút, tạm dừng sau 20 lần liên tiếp giá không đổi và tự quét lại lúc 08:30 giờ Việt Nam.';
const html = (await readFile('index.html', 'utf8'))
  .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="referrer" content="no-referrer">\n  <meta http-equiv="Content-Security-Policy" content="' + policy + '">')
  .replace('href="/style.css"', 'href="./style.css"')
  .replace('src="/app.js"', 'src="./app.js"')
  .replace('href="/"', 'href="./"')
  .replace('data-endpoint="/api/prices"', endpointAttributes)
  .replace('Trang kiểm tra bảng giá mỗi 60 giây khi đang mở.', syncDescription);

await mkdir('dist/pages', { recursive: true });
await Promise.all([
  writeFile('dist/pages/index.html', html),
  writeFile('dist/pages/style.css', await readFile('style.css')),
  writeFile('dist/pages/app.js', await readFile('app.js')),
  writeFile('dist/pages/prices.json', JSON.stringify(snapshot))
]);
console.log('Nguồn đã đồng bộ:', snapshot.sources.filter(source => source.status === 'ok').length);
if (next) console.log('Số lần quét giá không đổi:', next.unchanged, 'Mở lại:', next.pausedUntil ?? 'Đang quét');
await workflowOutput(true, next);
