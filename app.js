const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const localTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit'
});
const sourceTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric'
});
let data;
let kind = 'all';
let busy = false;
let disconnected = false;
let snapshotExpired = false;
const status = $('status');
const endpoint = status.dataset.endpoint;
const liveEndpoint = status.dataset.liveEndpoint;
const usesSnapshot = endpoint === './prices.json';
let currentPage = 1;
const pageSize = 24;
const unit = $('unit');
const region = $('region');
const brand = $('brand-filter');
const prices = $('prices');
const pills = Array.from(document.querySelectorAll('[data-kind]'));
const brandPriority = new Map([['sjc', 0], ['doji', 1], ['btmh', 2], ['btmc', 3]]);
const northernRegions = new Set(['Hà Nội', 'Miền Bắc']);

function compareQuotes(a, b) {
  const regionPriority = Number(northernRegions.has(b.region)) - Number(northernRegions.has(a.region));
  const priority = (brandPriority.get(a.brandId) ?? 4) - (brandPriority.get(b.brandId) ?? 4);
  return regionPriority || priority || Number(b.reference) - Number(a.reference) || a.brand.localeCompare(b.brand, 'vi');
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

function renderRows(rows) {
  $('row-count').textContent = rows.length + ' niêm yết · ' + (unit.value === 'chi' ? 'đồng/chỉ' : 'đồng/lượng');
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  currentPage = Math.min(currentPage, pageCount);
  $('pagination').hidden = pageCount === 1;
  $('previous').disabled = currentPage === 1;
  $('next').disabled = currentPage === pageCount;
  $('page-number').textContent = currentPage + ' / ' + pageCount;
  if (!rows.length) {
    const cell = make('td', 'Không có giá niêm yết phù hợp với bộ lọc.', 'empty');
    cell.colSpan = 6;
    const tr = make('tr');
    tr.append(cell);
    prices.replaceChildren(tr);
    return;
  }
  const offset = (currentPage - 1) * pageSize;
  prices.replaceChildren(...rows.slice(offset, offset + pageSize).map(row => {
    const tr = make('tr');
    const item = make('td');
    item.append(make('span', row.name, 'product'), make('span', row.brand, 'meta'));
    const expired = row.cached || disconnected || snapshotExpired || row.time && Date.now() - Date.parse(row.time) > 86_400_000;
    const timing = make('td', row.time ? sourceTime.format(new Date(row.time)) : '—', 'timing');
    if (expired) timing.append(make('div', row.cached || disconnected || snapshotExpired ? 'Giá đã lưu' : 'Quá 24 giờ', 'meta stale'));
    tr.append(item, make('td', row.region), make('td', money(row.buy), 'num buy'),
      make('td', money(row.sell), 'num sell'), make('td', money(row.spread), 'num'), timing);
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
  const allRows = data.sources.flatMap(source => source.rows.map(row => ({
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
    const link = make('a', source.name);
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    const labels = { ok: 'Đã đồng bộ', cached: 'Dùng giá đã lưu', unavailable: 'Chưa kết nối' };
    const reasons = { blocked: 'Nguồn chặn truy cập tự động', timeout: 'Nguồn phản hồi quá chậm',
      http_error: 'Nguồn không phản hồi thành công', bad_response: 'Chưa đọc được bảng giá' };
    const detail = source.partial ? 'Đã đồng bộ một phần' :
      source.status === 'unavailable' && reasons[source.reason] || labels[source.status];
    li.append(link, make('span', detail, 'source-state ' + source.status));
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

async function refresh(manual = false) {
  if (busy) return;
  busy = true;
  $('refresh').disabled = true;
  if (manual && liveEndpoint) status.textContent = 'Đang yêu cầu giá mới từ các nguồn…';
  try {
    const response = await fetch(manual && liveEndpoint ? liveEndpoint : endpoint, {
      signal: AbortSignal.timeout(25_000), cache: 'no-store', credentials: manual && liveEndpoint ? 'omit' : 'same-origin'
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const next = await response.json();
    data = mergePrices(next, data, manual);
    disconnected = false;
    const active = data.sources.filter(source => source.status === 'ok').length;
    snapshotExpired = usesSnapshot && Date.now() - Date.parse(data.checkedAt) > 15 * 60_000;
    status.dataset.live = String(active > 0 && !snapshotExpired);
    if (usesSnapshot) {
      const online = manual && liveEndpoint ? next.sources.filter(source => source.status === 'ok').length : active;
      status.textContent = (snapshotExpired ? 'Giá đã lưu · ' : online + '/' + data.sources.length + ' nguồn · ') +
        'Lần lấy giá ' + sourceTime.format(new Date(data.checkedAt));
    } else {
      status.textContent = active + '/' + data.sources.length + ' nguồn đã đồng bộ · Kiểm tra lúc ' +
        localTime.format(new Date(data.checkedAt));
    }
    options(brand, data.sources.map(source => [source.id, source.name]));
    const regions = Array.from(new Set(data.sources.flatMap(source => source.rows.map(row => row.region))));
    options(region, regions.sort((a, b) => a.localeCompare(b, 'vi')).map(value => [value, value]));
    showSources();
    render();
  } catch {
    disconnected = true;
    $('status').dataset.live = 'false';
    $('status').textContent = data && manual && liveEndpoint ? 'Chưa lấy được giá mới · Đang giữ bảng giá đã tải' :
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
$('previous').addEventListener('click', () => { currentPage -= 1; render(); });
$('next').addEventListener('click', () => { currentPage += 1; render(); });
$('refresh').addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
refresh();
