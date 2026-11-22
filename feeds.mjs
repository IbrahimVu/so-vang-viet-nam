const zones = [
  ['00', 'TP. Hồ Chí Minh'], ['07', 'Cần Thơ'], ['11', 'Hà Nội'],
  ['13', 'Đà Nẵng'], ['14', 'Tây Nguyên'], ['21', 'Đông Nam Bộ']
];

const maxFeedBytes = 2 * 1024 * 1024;
const sjcUrl = 'https://sjc.com.vn/bieu-do-gia-vang';
const btmcUrl = 'https://btmc.vn/gia-vang-theo-ngay.html';

async function fetchFeed(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json, text/html;q=0.9, application/xml;q=0.8', 'Cache-Control': 'no-cache' },
    redirect: 'manual',
    signal: AbortSignal.timeout(8500)
  });
  if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > maxFeedBytes) {
    await response.body?.cancel();
    const error = new Error('Source response rejected');
    error.sourceReason = response.status === 403 ? 'blocked' : !response.ok ? 'http_error' : 'bad_response';
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxFeedBytes) {
        await reader.cancel();
        throw new Error('Source response exceeds the size limit');
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  parts.push(decoder.decode());
  return parts.join('');
}

function plain(value) {
  return value.replace(/<[^>]+>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => {
    const number = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return number <= 0x10ffff ? String.fromCodePoint(number) : '';
  }).replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function ascii(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/đ/g, 'd');
}

function quoteTime(value) {
  if (typeof value !== 'string') return null;
  if (/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  const date = value.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  const iso = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  const time = value.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if ((!date && !iso) || !time) return null;
  const [, year, month, day] = iso || [null, date[3], date[2].padStart(2, '0'), date[1].padStart(2, '0')];
  const hours = time[4] ? Number(time[1]) % 12 + (time[4].toUpperCase() === 'PM' ? 12 : 0) : Number(time[1]);
  const millis = Date.parse(year + '-' + month + '-' + day + 'T' +
    String(hours).padStart(2, '0') + ':' + time[2] + ':' + (time[3] ?? '00') + '+07:00');
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function parsePrice(value, scale) {
  if (value == null || !/^(?:\d+|\d{1,3}(?:[.,]\d{3})+)$/.test(String(value).trim())) return null;
  const result = Number(String(value).replace(/[.,]/g, '')) * scale;
  return result >= 500_000 && result <= 40_000_000 ? result : null;
}

function quote(name, buy, sell, scale, region, time, kind, reference) {
  if (typeof name !== 'string') return null;
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!name || name.length > 180) return null;
  const product = ascii(name);
  const unitPriceBuy = parsePrice(buy, scale);
  const unitPriceSell = parsePrice(sell, scale);
  if ((!unitPriceBuy && !unitPriceSell) || (unitPriceBuy && unitPriceSell && unitPriceBuy > unitPriceSell)) return null;
  return { name, buy: unitPriceBuy, sell: unitPriceSell, region, time,
    kind: kind ?? (/nhan\b/.test(product) ? 'ring' : /mieng|\bsjc\b/.test(product) ? 'bar' : 'other'),
    reference: reference ?? (/\bsjc\b/.test(product) && !/phi sjc|nhan|nu trang|nguyen lieu/.test(product)) };
}

function tableRows(html) {
  return Array.from(html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), match =>
    Array.from(match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi), cell => plain(cell[1])));
}

async function pnj() {
  const results = await Promise.allSettled(zones.map(async ([zone, region]) => {
    const payload = JSON.parse(await fetchFeed('https://edge-api.pnj.io/ecom-frontend/v1/get-gold-price?zone=' + zone));
    const rows = payload.data.map(item => quote(item.tensp, item.giamua, item.giaban, 1000, region,
      quoteTime(payload.updateDate), undefined, item.masp === 'SJC')).filter(Boolean);
    if (!rows.length) throw new Error('Empty PNJ region');
    return rows;
  }));
  return { rows: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    partial: results.some(result => result.status === 'rejected') };
}

async function phuQuy() {
  const html = await fetchFeed('https://phuquygroup.vn/');
  const time = quoteTime(plain(html.match(/<p\b[^>]*class="update-time"[^>]*>(.*?)<\/p>/is)?.[1] ?? ''));
  const rows = Array.from(html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), ([, row]) => {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => plain(cell[1]));
    const [name, buy, sell] = cells;
    if (!name || !/^vàng|^nhẫn|^phú quý/i.test(name)) return null;
    return quote(name, buy, sell, 1, 'Bảng giá Phú Quý', time);
  }).filter(Boolean);
  return { rows };
}

async function btmcDaily() {
  const html = await fetchFeed(btmcUrl);
  const dateControl = html.match(/<input\b[^>]*\bid="datepicker11"[^>]*>/i)?.[0] ?? '';
  const date = dateControl.match(/\bvalue="(\d{2}\/\d{2}\/\d{4})"/i)?.[1];
  const today = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' }).format();
  if (date !== today || !/ĐVT 1 = 1\.000 VNĐ/i.test(plain(html))) {
    throw new Error('BTMC daily date or unit could not be verified');
  }
  const table = html.split('(buy)')[1]?.split('</table>')[0] ?? '';
  const rows = tableRows(table).map(cells => {
    const [name, , buy, sell] = cells.slice(-5, -1);
    if (!name || !/^(vàng|nhẫn|quà mừng|trang sức vàng)/i.test(name)) return null;
    return quote(name, buy, sell, 1000, 'Hà Nội', null);
  }).filter(Boolean);
  return { rows };
}

async function btmc(env) {
  let apiKey = env?.BTMC_API_KEY;
  if (!apiKey && env?.readPublishedBtmcKey) {
    try {
      const docs = await fetchFeed('https://btmc.vn/thong-tin/tai-lieu-api/api-gia-vang-17784.html');
      apiKey = docs.match(/getpricebtmc\?key=([a-z0-9]{20,60})/i)?.[1];
    } catch {}
  }
  if (apiKey) {
    try {
      const endpoint = new URL('https://api.btmc.vn/api/BTMCAPI/getpricebtmc');
      endpoint.searchParams.set('key', apiKey);
      const payload = JSON.parse(await fetchFeed(endpoint));
      const rows = payload.DataList.Data.map(item => {
        const id = item['@row'];
        const name = item['@n_' + id];
        if (typeof name !== 'string' || !/^(vàng|nhẫn|quà mừng|trang sức vàng|bản vàng)/i.test(name)) return null;
        return quote(name, item['@pb_' + id], item['@ps_' + id], 1, 'Hà Nội', quoteTime(item['@d_' + id]));
      }).filter(Boolean);
      if (rows.length) return { rows };
    } catch {
      // Try BTMC's public daily board if its official API is temporarily unavailable.
    }
  }
  return btmcDaily();
}

async function miHong() {
  const payload = JSON.parse(await fetchFeed('https://api.mihong.com/v1/gold-prices?market=domestic'));
  return { rows: payload.map(item => quote(item.code === 'SJC' ? 'Vàng miếng SJC' : 'Vàng ' + item.code,
    item.buyingPrice, item.sellingPrice, 1, 'TP. Hồ Chí Minh', quoteTime(item.dateTime),
    item.code === 'SJC' ? 'bar' : 'other', item.code === 'SJC')).filter(Boolean) };
}

async function btmh() {
  const html = await fetchFeed('https://baotinmanhhai.vn/bang-gia-vang');
  const table = html.split('id="gold_price_table-49"')[1]?.split('id="quick_buy-')[0] ?? '';
  if (!table.includes('Đơn vị tính (ĐVT): chỉ') || !table.includes('Đơn giá (nghìn VNĐ)')) {
    throw new Error('Unknown BTMH unit');
  }
  const time = quoteTime(plain(table.slice(table.lastIndexOf('Cập nhật lúc'), -1)));
  const rows = table.split('role="row">').slice(1).map(body => {
    const [name, , buy, sell] = [...body.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(cell => plain(cell[1]));
    if (!name || /tiểu kim cát/i.test(name)) return null;
    return quote(name, buy, sell, 1000, 'Bảng giá BTMH', time);
  }).filter(Boolean);
  return { rows };
}

async function sjc() {
  const html = await fetchFeed(sjcUrl);
  const time = quoteTime(plain(html).match(/(?:cập nhật|thời điểm)[\s\S]{0,80}/i)?.[0]);
  const table = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
    .find(([, value]) => /nghin dong\s*\/\s*luong.*mua.*ban/.test(ascii(plain(value))));
  if (!table) throw new Error('No official SJC table');
  const title = ascii(plain(html));
  const perLuong = /(?:1[.,]000|nghin)\s*(?:vnd|dong|d)\s*\/\s*luong/.test(title);
  const perChi = /(?:1[.,]000|nghin)\s*(?:vnd|dong|d)\s*\/\s*chi/.test(title);
  if (perLuong === perChi) throw new Error('Unknown SJC unit');
  return { rows: tableRows(table[1]).map(([, label, buy, sell]) => {
    if (!label) return null;
    // The official board may append a signed price change after the quoted price.
    const amount = value => value?.match(/^\s*(\d[\d.,]*)(?:\s*[+-]\s*[\d.,]+)?\s*$/)?.[1];
    const isProduct = /vang|nhan|nu trang/i.test(ascii(label));
    return quote(isProduct ? label : 'Vàng miếng SJC', amount(buy), amount(sell), perLuong ? 100 : 1000,
      isProduct ? 'Bảng giá SJC' : label, time);
  }).filter(Boolean) };
}

async function doji() {
  const { data } = JSON.parse(await fetchFeed('https://banggia.doji.vn/api/TablePrice/GetTablePrice'));
  // The public DOJI price board ships this key in its browser bundle to decode its quote payload.
  const publicKey = '7a4b8c3d1e9f2a5b6c0d4e8f3a7b1c5d9e2f6a0b4c8d3e7f1a5b9c2d6e0f4a8b';
  const keyBytes = Uint8Array.from(publicKey.match(/../g), hex => parseInt(hex, 16));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
  const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: bytes.slice(0, 16) }, key, bytes.slice(16));
  const payload = JSON.parse(new TextDecoder().decode(decrypted));
  return { rows: payload.filter(item => item.type === 'G' && item.isActive).map(item =>
    quote(item.materialName, item.priceDojiBuyIn, item.priceDojiSellOut, 1000, 'Bảng giá DOJI',
      null, undefined, item.materialCode === '01')).filter(Boolean) };
}

async function ngocTham() {
  const payload = JSON.parse(await fetchFeed('https://ngoctham.com/ajax/proxy_banggia.php'));
  return { rows: payload.chitiet.map(item => quote(item.loaivang,
    Number(item.chihiengiamua) === 1 ? null : item.giamua,
    Number(item.chihiengiaban) === 1 ? null : item.giaban,
    1, 'Bảng giá Ngọc Thẩm', quoteTime(payload.date))).filter(Boolean) };
}

const sources = [
  { id: 'sjc', name: 'SJC', url: sjcUrl, read: sjc },
  { id: 'doji', name: 'DOJI', url: 'https://banggia.doji.vn/', read: doji },
  { id: 'pnj', name: 'PNJ', url: 'https://www.pnj.com.vn/site/gia-vang', read: pnj },
  { id: 'btmc', name: 'Bảo Tín Minh Châu', url: btmcUrl, read: btmc },
  { id: 'phu-quy', name: 'Phú Quý', url: 'https://phuquygroup.vn/', read: phuQuy },
  { id: 'mi-hong', name: 'Mi Hồng', url: 'https://mihong.vn/gia-vang-trong-nuoc', read: miHong },
  { id: 'btmh', name: 'Bảo Tín Mạnh Hải', url: 'https://baotinmanhhai.vn/bang-gia-vang', read: btmh },
  { id: 'ngoc-tham', name: 'Ngọc Thẩm', url: 'https://ngoctham.com/bang-gia-vang/', read: ngocTham }
];
