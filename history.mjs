const archive = 'https://giavang.day/lich-su/';
const published = 'https://ibrahimvu.github.io/so-vang-viet-nam/history.json';
const brands = new Set(['sjc', 'doji', 'btmh', 'btmc', 'pnj', 'phuquy', 'mihong', 'ngoctham']);
const day = 86_400_000;
const vietnamDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });

function clean(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
}

function amount(cell) {
  const text = cell?.match(/<span class="num-full">([\d.]+)<\/span>/)?.[1];
  const price = Number(text?.replaceAll('.', ''));
  return Number.isInteger(price) && price >= 500_000 && price <= 40_000_000 ? price : null;
}

export function readArchive(html, date) {
  if (!html.includes('<link rel="canonical" href="' + archive + date + '">')) return [];
  const quotes = new Map();
  for (const [, brand, table] of html.matchAll(/<section class="term-histcard" data-source="([a-z]+)"[^>]*>([\s\S]*?)<\/section>/g)) {
    if (!brands.has(brand) || !table.includes('Loại vàng · đ/chỉ')) continue;
    for (const [, code, line] of table.matchAll(/<tr data-gold-type="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...line.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell);
      const area = cells[0]?.match(/<span class="cell-dim">\s*—\s*(.*?)<\/span>/s);
      const region = area ? clean(area[1]) : '';
      const name = clean(area ? cells[0].replace(area[0], '') : cells[0] ?? '');
      const buy = amount(cells[1]);
      const sell = amount(cells[2]);
      if (!name || name.length > 160 || code.length > 160 || region.length > 60 ||
          (buy == null && sell == null) || (buy != null && sell != null && buy > sell)) continue;
      quotes.set(JSON.stringify([brand, code, region]), [brand, code, name, region, buy, sell]);
    }
  }
  return [...quotes.values()];
}

async function get(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Archive HTTP ' + response.status);
  return response;
}

export async function buildHistory(now, refresh = true) {
  const end = vietnamDay.format(now - day);
  const dates = Array.from({ length: 30 }, (_, i) => vietnamDay.format(now - (30 - i) * day));
  const previous = await get(published).then(response => response.json()).catch(() => null);
  const days = Object.fromEntries(dates.filter(date => previous?.version === 1 && Array.isArray(previous.days?.[date]))
    .map(date => [date, previous.days[date]]));
  if (!refresh && Object.keys(days).length) return { version: 1, end, days };
  // Recheck the latest days in case the archive published prices after the first collection.
  const pending = dates.filter((date, i) => !days[date]?.length || i >= dates.length - 3);
  for (let i = 0; i < pending.length; i += 4) {
    await Promise.all(pending.slice(i, i + 4).map(async date => {
      try {
        const rows = readArchive(await (await get(archive + date)).text(), date);
        if (rows.length) {
          const combined = new Map();
          for (const row of [...(days[date] ?? []), ...rows]) {
            combined.set(JSON.stringify([row[0], row[1], row[3]]), row);
          }
          days[date] = [...combined.values()];
        }
      } catch {
        // Leave absent days empty and keep any previously published records.
      }
    }));
  }
  return { version: 1, end, days };
}
