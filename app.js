const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const localTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit'
});
const sourceTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric'
});
const vietnamClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
let data;
let kind = 'all';
let busy = false;
let disconnected = false;
let snapshotExpired = false;
const status = $('status');
const endpoint = status.dataset.endpoint;
const liveEndpoint = status.dataset.liveEndpoint;
const fallbackEndpoint = status.dataset.fallbackEndpoint;
const refreshEndpoint = status.dataset.refreshEndpoint;
const priceKey = status.dataset.priceKey;
const usesSnapshot = endpoint === './prices.json' || Boolean(fallbackEndpoint);
let currentPage = 1;
const compactQuotes = matchMedia('(max-width: 820px)');
const unit = $('unit');
const region = $('region');
const brand = $('brand-filter');
const prices = $('prices');
const pills = Array.from(document.querySelectorAll('[data-kind]'));
const brandPriority = new Map([['sjc', 0], ['doji', 1], ['btmh', 2], ['btmc', 3]]);
const northernRegions = new Map([
  ['Hà Nội', 0], ['Miền Bắc', 1], ['Hải Phòng', 2], ['Hạ Long', 2], ['Quảng Ninh', 2]
]);

function quoteRegionPriority(row) {
  const north = northernRegions.get(row.region);
  if (north != null) return north;
  // Some brands publish one board without a regional label.
  return row.region?.startsWith('Bảng giá ') ? 3 : 4;
}

function quoteGroup(row) {
  const preferred = brandPriority.has(row.brandId);
  if (preferred) return quoteRegionPriority(row) < 4 ? 0 : 1;
  return northernRegions.has(row.region) ? 2 : 3;
}

function compareQuotes(a, b) {
  const groupDifference = quoteGroup(a) - quoteGroup(b);
  const priority = (brandPriority.get(a.brandId) ?? 4) - (brandPriority.get(b.brandId) ?? 4);
  return groupDifference || priority || quoteRegionPriority(a) - quoteRegionPriority(b) ||
    Number(b.reference) - Number(a.reference) || a.brand.localeCompare(b.brand, 'vi');
}

function visibleQuote(row) {
  const name = row.name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const excluded = /\b(?:nu trang|trang suc|nguyen lieu|vang he thong|vang thi truong|phi sjc)\b/.test(name);
  // Generic purity labels are metal quotes without an identified bar, ring, or bullion product.
  const purityOnly = /^vang (?:\d+(?:[.,]\d+)?k?(?: \d{3,4}| ?\(\d+(?:[.,]\d+)?k\))?|trang au\d+)$/i.test(name);
  return !excluded && !purityOnly;
}

function make(tag, value, cls) {
  const el = document.createElement(tag);
  if (value != null) el.textContent = value;
  if (cls) el.className = cls;
  return el;
}

function money(value) {
  return value == null ? '—' : format.format(value * (unit.value === 'chi' ? 1 : 10));
}

function options(select, values) {
  const current = select.value;
  select.querySelectorAll('option:not(:first-child)').forEach(option => option.remove());
  for (const [key, label] of values) select.add(new Option(label, key));
  if (Array.from(select.options).some(option => option.value === current)) select.value = current;
}

function quoteCell(label, value, className) {
  const cell = make('td', null, className);
  cell.setAttribute('role', 'cell');
  if (label) {
    const heading = make('span', label, 'cell-label');
    heading.setAttribute('aria-hidden', 'true');
    cell.append(heading);
  }
  if (value != null) cell.append(make('span', value));
  return cell;
}

function renderRows(rows) {
  const pageSize = compactQuotes.matches ? 8 : 24;
  $('row-count').textContent = rows.length + ' niêm yết · ' + (unit.value === 'chi' ? 'đồng/chỉ' : 'đồng/lượng');
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  currentPage = Math.min(currentPage, pageCount);
  $('pagination').hidden = pageCount === 1;
  $('previous').disabled = currentPage === 1;
  $('next').disabled = currentPage === pageCount;
  $('page-number').textContent = currentPage + ' / ' + pageCount;
  if (!rows.length) {
    const cell = quoteCell('', 'Không có giá niêm yết phù hợp với bộ lọc.', 'empty');
    cell.colSpan = 6;
    const tr = make('tr');
    tr.setAttribute('role', 'row');
    tr.append(cell);
    prices.replaceChildren(tr);
    return;
  }
  const offset = (currentPage - 1) * pageSize;
  prices.replaceChildren(...rows.slice(offset, offset + pageSize).map(row => {
    const tr = make('tr', null, 'quote-row');
    tr.setAttribute('role', 'row');
    const item = quoteCell('', null, 'quote-product');
    item.append(make('span', row.name, 'product'), make('span', row.brand, 'meta'));
    const expired = row.cached || disconnected || snapshotExpired || row.time && Date.now() - Date.parse(row.time) > 86_400_000;
    const timing = quoteCell('Giờ niêm yết', row.time ? sourceTime.format(new Date(row.time)) : '—', 'timing');
    if (expired) timing.append(make('div', row.cached || disconnected || snapshotExpired ? 'Giá đã lưu' : 'Quá 24 giờ', 'meta stale'));
    tr.append(item, quoteCell('Khu vực', row.region, 'quote-region'),
      quoteCell('Mua vào', money(row.buy), 'num buy'), quoteCell('Bán ra', money(row.sell), 'num sell'),
      quoteCell('Chênh lệch', money(row.spread), 'num spread'), timing);
    return tr;
  }));
}

function renderSummary(rows) {
  const eligible = rows.filter(row => row.reference && !row.cached && !disconnected && !snapshotExpired &&
    (!row.time || Date.now() - Date.parse(row.time) <= 86_400_000) && row.buy != null && row.sell != null);
  const metrics = [
    ['high-buy', 'high-brand', 'buy', -1],
    ['low-sell', 'low-brand', 'sell', 1],
    ['low-spread', 'spread-brand', 'spread', 1]
  ];
  for (const [id, label, field, order] of metrics) {
    const best = eligible.reduce((current, row) => !current || order * (row[field] - current[field]) < 0 ? row : current, null);
    $(id).textContent = best ? money(best[field]) + ' đ' : '—';
    $(label).textContent = best ? 'Miếng SJC · ' + best.brand + ' · ' + best.region : 'Vàng miếng SJC';
  }
}

function render() {
  if (!data) return;
  const allRows = data.sources.flatMap(source => source.rows.filter(visibleQuote).map(row => ({
    ...row, brand: source.name, brandId: source.id, cached: source.status === 'cached',
    spread: row.sell == null || row.buy == null ? null : row.sell - row.buy
  })));
  const areaRows = allRows.filter(row => region.value === 'all' || row.region === region.value)
    .sort(compareQuotes);
  renderSummary(areaRows.filter(row => brand.value === 'all' || row.brandId === brand.value));
  renderRows(areaRows.filter(row => (kind === 'all' || row.kind === kind) &&
    (brand.value === 'all' || row.brandId === brand.value)));
}

function showSources() {
  $('source-list').replaceChildren(...data.sources.map(source => {
    const li = make('li');
    let url;
    try { url = new URL(source.url); } catch {}
    const canLink = url?.protocol === 'https:' && !url.username && !url.password;
    const label = make(canLink ? 'a' : 'span', source.name);
    if (canLink) {
      label.href = url.href;
      label.target = '_blank';
      label.rel = 'noopener noreferrer';
      label.referrerPolicy = 'no-referrer';
    }
    const labels = { ok: 'Đã đồng bộ', cached: 'Dùng giá đã lưu', unavailable: 'Chưa kết nối' };
    const reasons = { blocked: 'Nguồn chặn truy cập tự động', timeout: 'Nguồn phản hồi quá chậm',
      http_error: 'Nguồn không phản hồi thành công', bad_response: 'Chưa đọc được bảng giá' };
    const detail = source.partial ? 'Đã đồng bộ một phần' :
      source.status === 'unavailable' && reasons[source.reason] || labels[source.status];
    li.append(label, make('span', detail, 'source-state ' + source.status));
    return li;
  }));
}

function mergePrices(next, previous, manual) {
  if (!previous) return next;
  const sources = next.sources.map(source => {
    const saved = previous.sources.find(item => item.id === source.id);
    if (!saved?.rows.length) return source;
    if (source.status !== 'ok') {
      if (!manual && saved.status === 'ok' && Date.parse(saved.checkedAt) >= Date.parse(next.checkedAt)) return saved;
      if (!source.rows.length || Date.parse(saved.checkedAt) > Date.parse(source.checkedAt)) {
        return { ...source, rows: saved.rows, checkedAt: saved.checkedAt, status: 'cached' };
      }
    }
    if (Date.parse(saved.checkedAt) > Date.parse(source.checkedAt)) return saved;
    return source;
  });
  const checkedAt = Date.parse(previous.checkedAt) > Date.parse(next.checkedAt) ? previous.checkedAt : next.checkedAt;
  return { ...next, checkedAt, sources };
}

async function loadPriceData(url, credentials, timeout = 25_000) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = priceKey && url === endpoint ? { apikey: priceKey } : undefined;
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store', credentials, headers, redirect: 'error' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const snapshot = await response.json();
    if (!Array.isArray(snapshot.sources) || !Number.isFinite(Date.parse(snapshot.checkedAt))) throw new Error('Invalid price data');
    return snapshot;
  } finally {
    clearTimeout(deadline);
  }
}

async function requestGoldScan() {
  const response = await fetch(refreshEndpoint, {
    method: 'POST', headers: { apikey: priceKey, 'Content-Type': 'application/json' },
    body: '{}', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Không gửi được yêu cầu quét');
  return response.json();
}

async function waitForGoldScan({ outcome, requestedAt }) {
  if (outcome === 'daily_limit') return null;
  const threshold = Date.parse(requestedAt);
  if (!Number.isFinite(threshold) || (outcome !== 'queued' && outcome !== 'cooldown')) {
    throw new Error('Trạng thái quét không hợp lệ');
  }
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    const snapshot = await loadPriceData(endpoint, 'omit', 5000);
    if (Date.parse(snapshot.checkedAt) >= threshold) return snapshot;
  }
  return null;
}

async function refresh(manual = false) {
  if (busy) return;
  busy = true;
  $('refresh').disabled = true;
  const manualLive = manual && !!liveEndpoint;
  const manualScan = manual && !!refreshEndpoint;
  if (manualLive || manualScan) status.textContent = 'Đang yêu cầu giá mới từ các nguồn…';
  try {
    let usingFallback = false;
    let scanNotice;
    let next;
    if (manualScan) {
      try {
        const result = await requestGoldScan();
        next = await waitForGoldScan(result);
        if (!next) scanNotice = result.outcome === 'daily_limit' ? 'Đã đạt giới hạn làm mới trong ngày' :
          'Chưa có kết quả quét mới';
      } catch {
        scanNotice = 'Chưa lấy được giá mới theo yêu cầu';
      }
    }
    next ??= await loadPriceData(manualLive ? liveEndpoint : endpoint,
      manualLive || fallbackEndpoint ? 'omit' : 'same-origin', fallbackEndpoint && !manualLive ? 10_000 : 25_000)
      .catch(error => {
        if (!fallbackEndpoint || manualLive) throw error;
        usingFallback = true;
        return loadPriceData(fallbackEndpoint, 'same-origin');
      });
    data = mergePrices(next, data, manual);
    disconnected = usingFallback;
    const active = data.sources.filter(source => source.status === 'ok').length;
    snapshotExpired = usesSnapshot && Date.now() - Date.parse(data.checkedAt) > 15 * 60_000;
    status.dataset.live = String(active > 0 && !snapshotExpired && !usingFallback);
    if (usesSnapshot) {
      const online = manual && liveEndpoint ? next.sources.filter(source => source.status === 'ok').length : active;
      const vietnamTime = vietnamClock.format(new Date());
      const waiting = vietnamTime >= '08:30' && vietnamTime <= '20:30' ? 'Chờ lượt quét mới' : 'Ngoài giờ quét';
      const details = scanNotice ?? (usingFallback ? 'Đang dùng giá đã lưu' : snapshotExpired ? waiting : online + '/' + data.sources.length + ' nguồn');
      status.textContent = details + ' · ' +
        'Lần lấy giá ' + sourceTime.format(new Date(data.checkedAt));
    } else {
      status.textContent = active + '/' + data.sources.length + ' nguồn đã đồng bộ · Kiểm tra lúc ' +
        localTime.format(new Date(data.checkedAt));
    }
    options(brand, data.sources.map(source => [source.id, source.name]));
    const regions = Array.from(new Set(data.sources.flatMap(source => source.rows.filter(visibleQuote).map(row => row.region))));
    options(region, regions.sort((a, b) => a.localeCompare(b, 'vi')).map(value => [value, value]));
    showSources();
    render();
  } catch {
    disconnected = true;
    $('status').dataset.live = 'false';
    $('status').textContent = data && (manualLive || manualScan) ? 'Chưa lấy được giá mới · Đang giữ bảng giá đã tải' :
      data ? 'Mất kết nối · Đang hiển thị giá đã lưu' : 'Chưa kết nối được bảng giá';
    if (data) render();
    else prices.querySelector('td').textContent = 'Không tải được giá. Chọn Làm mới để thử lại.';
  } finally {
    busy = false;
    $('refresh').disabled = false;
  }
}

pills.forEach(button => button.addEventListener('click', () => {
  kind = button.dataset.kind;
  currentPage = 1;
  pills.forEach(pill => pill.setAttribute('aria-pressed', String(pill === button)));
  render();
}));
for (const control of [brand, region]) control.addEventListener('change', () => {
  currentPage = 1;
  render();
});
unit.addEventListener('change', render);
function changePage(step) {
  currentPage += step;
  render();
  if (compactQuotes.matches) $('bang-gia').scrollIntoView({ block: 'start' });
}
$('previous').addEventListener('click', () => changePage(-1));
$('next').addEventListener('click', () => changePage(1));
compactQuotes.addEventListener('change', () => { currentPage = 1; render(); });
$('refresh').addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
refresh();

const historyProduct = $('history-product');
const historyChart = $('history-chart');
const historyPlot = $('history-plot');
const historyButtons = Array.from(document.querySelectorAll('[data-history-days]'));
const historyBrands = new Map([
  ['sjc', 'SJC'], ['doji', 'DOJI'], ['btmh', 'Bảo Tín Mạnh Hải'], ['btmc', 'Bảo Tín Minh Châu'],
  ['pnj', 'PNJ'], ['phuquy', 'Phú Quý'], ['mihong', 'Mi Hồng'], ['ngoctham', 'Ngọc Thẩm']
]);
const historyProducts = new Map();
const chartAxis = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const calendarDay = 86_400_000;
const shortDate = date => date.slice(8, 10) + '/' + date.slice(5, 7);
let historyEnd;
let historyDays = 7;
let chartPoints = [];

function drawHistory() {
  if (historyPlot.hidden) return;
  const width = historyChart.clientWidth;
  const height = historyChart.clientHeight;
  const context = historyChart.getContext('2d');
  if (!context || width < 90 || !height) return;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  historyChart.width = Math.round(width * scale);
  historyChart.height = Math.round(height * scale);
  context.scale(scale, scale);

  const prices = chartPoints.flatMap(point => point.slice(1).filter(Number.isFinite));
  const floor = Math.floor(Math.min(...prices) * 10 - 1) / 10;
  const ceiling = Math.ceil(Math.max(...prices) * 10 + 1) / 10;
  const left = 42;
  const right = width - 14;
  const top = 13;
  const bottom = height - 29;
  const x = index => left + index * (right - left) / (chartPoints.length - 1);
  const y = value => bottom - (value - floor) * (bottom - top) / (ceiling - floor);
  context.font = '12px system-ui';
  context.textBaseline = 'middle';
  context.fillStyle = '#52645e';
  context.strokeStyle = '#dfe7e1';
  context.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const value = floor + i * (ceiling - floor) / 4;
    const line = y(value);
    context.beginPath();
    context.moveTo(left, line);
    context.lineTo(right, line);
    context.stroke();
    context.fillText(chartAxis.format(value), left - 6, line);
  }
  for (const index of [0, Math.floor(chartPoints.length / 2), chartPoints.length - 1]) {
    context.textAlign = index === 0 ? 'left' : index === chartPoints.length - 1 ? 'right' : 'center';
    context.fillText(shortDate(chartPoints[index][0]), x(index), bottom + 16);
  }
  for (const [column, color, dash] of [[1, '#196348', []], [2, '#925613', [5, 4]]]) {
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 2;
    context.setLineDash(dash);
    let previous = null;
    chartPoints.forEach((point, i) => {
      const value = point[column];
      if (Number.isFinite(previous) && Number.isFinite(value)) {
        context.beginPath();
        context.moveTo(x(i - 1), y(previous));
        context.lineTo(x(i), y(value));
        context.stroke();
      }
      if (Number.isFinite(value)) {
        context.beginPath();
        context.arc(x(i), y(value), 2.6, 0, Math.PI * 2);
        context.fill();
      }
      previous = value;
    });
  }
}

function renderHistory() {
  const product = historyProducts.get(historyProduct.value);
  if (!product) return;
  chartPoints = Array.from({ length: historyDays }, (_, i) => {
    const date = new Date(historyEnd - (historyDays - 1 - i) * calendarDay).toISOString().slice(0, 10);
    const [buy, sell] = product.quotes.get(date) ?? [];
    return [date, buy == null ? null : buy / 100_000, sell == null ? null : sell / 100_000];
  });
  const recorded = chartPoints.filter(point => point[1] != null || point[2] != null);
  historyPlot.hidden = !recorded.length;
  const period = shortDate(chartPoints[0][0]) + '–' + shortDate(chartPoints.at(-1)[0]);
  $('history-status').textContent = recorded.length + '/' + historyDays + ' ngày có dữ liệu · ' + period;
  $('history-rows').replaceChildren(...recorded.reverse().map(([date]) => {
    const [buy, sell] = product.quotes.get(date);
    const row = make('tr');
    const value = price => price == null ? '—' : format.format(price * 10);
    row.append(make('td', shortDate(date) + '/' + date.slice(0, 4)),
      make('td', value(buy), 'num'), make('td', value(sell), 'num'));
    return row;
  }));
  drawHistory();
}

async function loadHistory() {
  try {
    const response = await fetch('./history.json', { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('History request failed');
    const archive = await response.json();
    historyEnd = Date.parse(archive.end + 'T00:00:00Z');
    if (archive.version !== 1 || !Number.isFinite(historyEnd)) throw new Error('Invalid history');
    for (const [date, rows] of Object.entries(archive.days)) {
      for (const [brand, code, name, region, buy, sell] of rows) {
        if (!historyBrands.has(brand) || !visibleQuote({ name }) || /^\d+$/.test(name)) continue;
        const key = JSON.stringify([brand, code, region]);
        if (!historyProducts.has(key)) {
          historyProducts.set(key, { brand, label: name + (region ? ' · ' + region : ''), quotes: new Map() });
        }
        historyProducts.get(key).quotes.set(date, [buy, sell]);
      }
    }
    if (!historyProducts.size) throw new Error('History archive empty');
    historyProduct.replaceChildren();
    for (const [brand, label] of historyBrands) {
      const items = [...historyProducts].filter(([, product]) => product.brand === brand);
      if (!items.length) continue;
      const group = make('optgroup');
      group.label = label;
      group.append(...items.map(([key, product]) => new Option(product.label, key)));
      historyProduct.append(group);
    }
    historyProduct.disabled = false;
    renderHistory();
  } catch {
    $('history-status').textContent = 'Chưa tải được dữ liệu lịch sử. Hãy thử lại sau.';
    historyProduct.replaceChildren(new Option('Chưa có dữ liệu'));
    historyProduct.disabled = true;
  }
}

if (historyProduct) {
  historyProduct.addEventListener('change', renderHistory);
  historyButtons.forEach(button => button.addEventListener('click', () => {
    historyDays = Number(button.dataset.historyDays);
    historyButtons.forEach(option => option.setAttribute('aria-pressed', String(option === button)));
    renderHistory();
  }));
  new ResizeObserver(drawHistory).observe(historyChart);
  loadHistory();
}
