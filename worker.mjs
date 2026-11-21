const intervalMs = 60_000;
const memory = new Map();

function securityHeaders(protocol) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow'
  });
  if (protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  return headers;
}

async function readSource(source, cache, base, now) {
  const key = new Request(new URL('/.price-cache/' + source.id, base));
  let saved = memory.get(source.id);
  if (!saved && cache) {
    try { saved = await (await cache.match(key))?.json(); } catch {}
  }
  if (saved && now - Date.parse(saved.checkedAt) < intervalMs) return saved;

  try {
    const result = await source.read();
    if (!result.rows.length) throw new Error('Empty price list');
    const updated = { id: source.id, name: source.name, url: source.url,
      ...result, status: 'ok', checkedAt: new Date().toISOString() };
    memory.set(source.id, updated);
    if (cache) {
      try {
        await cache.put(key, Response.json(updated, { headers: { 'Cache-Control': 'max-age=604800' } }));
      } catch {}
    }
    return updated;
  } catch {
    console.warn('Không thể đồng bộ nguồn giá', source.id);
    return { id: source.id, name: source.name, url: source.url,
      status: saved ? 'cached' : 'unavailable', checkedAt: saved?.checkedAt ?? null,
      rows: saved?.rows ?? [] };
  }
}

function prices(base) {
  const now = Date.now();
  const cache = globalThis.caches?.default;
  return Promise.all(sources.map(source => readSource(source, cache, base, now)));
}

const assets = {
  '/': () => [page, 'text/html; charset=utf-8'],
  '/style.css': () => [css, 'text/css; charset=utf-8'],
  '/app.js': () => [script, 'text/javascript; charset=utf-8']
};

export default {
  async fetch(request) {
    const { pathname, protocol } = new URL(request.url);
    const headers = securityHeaders(protocol);
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) {
      headers.set('Allow', 'GET, HEAD');
      return new Response('Phương thức không được hỗ trợ', { status: 405, headers });
    }
    if (pathname === '/api/prices') {
      headers.set('Content-Type', 'application/json; charset=utf-8');
      if (head) return new Response(null, { headers });
      return Response.json({ sources: await prices(request.url), refreshSeconds: intervalMs / 1000,
        checkedAt: new Date().toISOString() }, { headers });
    }
    if (!Object.hasOwn(assets, pathname)) {
      return new Response(head ? null : 'Không tìm thấy', { status: 404, headers });
    }
    const [body, type] = assets[pathname]();
    headers.set('Content-Type', type);
    return new Response(head ? null : body, { headers });
  }
};
