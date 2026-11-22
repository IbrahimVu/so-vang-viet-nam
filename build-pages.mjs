import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import './build.mjs';
import { scanIntervalMs, scanSlot, scanWindowIsOpen } from './scan-window.mjs';

const { default: worker } = await import('./dist/server/index.js');
const liveOriginSetting = process.env.LIVE_PRICE_API_ORIGIN?.trim();
const liveOrigin = liveOriginSetting && URL.canParse(liveOriginSetting) ? new URL(liveOriginSetting) : null;
if (liveOriginSetting && (liveOrigin?.protocol !== 'https:' || liveOrigin.username || liveOrigin.password ||
    liveOrigin.pathname !== '/' || liveOrigin.search || liveOrigin.hash)) {
  throw new Error('LIVE_PRICE_API_ORIGIN phải là địa chỉ gốc HTTPS.');
}
const liveEndpoint = liveOrigin && new URL('/api/prices', liveOrigin).href;
const cloudSnapshot = process.env.PRICE_SNAPSHOT_URL?.trim();
if (cloudSnapshot && !/^https:\/\/storage\.googleapis\.com\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\/prices\.json$/.test(cloudSnapshot)) {
  throw new Error('PRICE_SNAPSHOT_URL must point to a public Cloud Storage prices.json object.');
}
const onGitHub = process.env.GITHUB_ACTIONS === 'true';
const isScheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
const isManual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
const now = Date.now();

async function workflowOutput(publish) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, 'publish=' + publish + '\n');
  }
}

const duringScanWindow = scanWindowIsOpen(now);
if (isScheduled && (cloudSnapshot || !duringScanWindow)) {
  console.log(cloudSnapshot ? 'Cloud Scheduler đang phụ trách quét giá.' : 'Ngoài khung giờ quét 08:30–20:30');
  await workflowOutput(false);
  process.exit(0);
}

async function fetchSnapshot() {
  const response = await worker.fetch(new Request('https://localhost/api/prices'), {
    BTMC_API_KEY: process.env.BTMC_API_KEY, readPublishedBtmcKey: true
  });
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
  const endpoint = cloudSnapshot || 'https://ibrahimvu.github.io/so-vang-viet-nam/prices.json';
  const url = endpoint + '?check=' + now;
  const response = await fetch(url, {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error('Không đọc được bản giá đã xuất bản để dùng cho lần triển khai này.');
  const snapshot = await response.json();
  if (!Array.isArray(snapshot.sources) || !Number.isFinite(Date.parse(snapshot.checkedAt))) {
    throw new Error('Bản giá đã xuất bản không hợp lệ.');
  }
  return snapshot;
}

const previous = cloudSnapshot ? await publishedSnapshot() :
  onGitHub ? await publishedSnapshot().catch(() => null) : null;
const lastScan = Date.parse(previous?.checkedAt);
const currentSlot = scanSlot(now);
if (isScheduled && lastScan >= currentSlot) {
  console.log('Đã có dữ liệu cho phiên quét 5 phút hiện tại.');
  await workflowOutput(false);
  process.exit(0);
}

const shouldScan = !cloudSnapshot && (!onGitHub || duringScanWindow &&
  (isScheduled || isManual || !(now - lastScan < 2 * scanIntervalMs)));
let snapshot = previous;
if (shouldScan) {
  try {
    snapshot = await fetchSnapshot();
    if (previous) {
      snapshot.sources = snapshot.sources.map(source => {
        const saved = previous.sources.find(item => item.id === source.id);
        return source.rows.length || !saved?.rows.length ? source :
          { ...source, status: 'cached', rows: saved.rows, checkedAt: saved.checkedAt };
      });
    }
  } catch (error) {
    if (isScheduled || !previous) throw error;
    console.warn('Chưa lấy được giá mới. Tiếp tục dùng bản giá đã xuất bản.');
  }
}
if (!snapshot) throw new Error('Không có bản giá để xuất bản.');
delete snapshot.scan;

const connect = [...new Set([liveEndpoint, cloudSnapshot].filter(Boolean).map(url => new URL(url).origin))]
  .map(origin => ' ' + origin).join('');
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'" +
  connect + "; base-uri 'none'; form-action 'none'";
const endpointAttributes = (cloudSnapshot ?
  'data-endpoint="' + cloudSnapshot + '" data-fallback-endpoint="./prices.json"' :
  'data-endpoint="./prices.json"') +
  (liveEndpoint ? ' data-live-endpoint="' + liveEndpoint + '"' : '');
const syncDescription = liveEndpoint ?
  'Quét mỗi 5 phút từ 08:30 đến 20:30 giờ Việt Nam. Chọn Làm mới để lấy giá theo yêu cầu.' :
  'Quét mỗi 5 phút từ 08:30 đến 20:30 giờ Việt Nam.';
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
await workflowOutput(true);
