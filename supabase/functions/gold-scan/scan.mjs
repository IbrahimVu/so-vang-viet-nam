const pagesSnapshot = 'https://ibrahimvu.github.io/so-vang-viet-nam/prices.json';

async function callRpc(project, serviceKey, name, input) {
  const headers = { apikey: serviceKey, 'Content-Type': 'application/json' };
  if (serviceKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + serviceKey;
  const response = await fetch(new URL('rest/v1/rpc/' + name, project), {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    redirect: 'error',
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('Database request failed');
  return response.json();
}

async function readPagesFallback() {
  try {
    const response = await fetch(pagesSnapshot, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (response.ok) return (await response.json()).sources;
  } catch {
    // Collection can still begin if the fallback is unreachable.
  }
  return [];
}

function matchingSecret(header, secret) {
  if (!secret || header?.length !== secret.length) return false;
  let difference = 0;
  for (let i = 0; i < secret.length; i++) difference |= header.charCodeAt(i) ^ secret.charCodeAt(i);
  return difference === 0;
}

export function createGoldScanner({ environment, collect, rpc = callRpc, fallback = readPagesFallback }) {
  return async function scan(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (!matchingSecret(request.headers.get('X-Gold-Scan-Secret'), environment.GOLD_SCAN_SECRET)) {
      return new Response(null, { status: 401 });
    }
    try {
      const { token } = await request.json();
      if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) return new Response(null, { status: 400 });
      const project = new URL('/', environment.SUPABASE_URL);
      const serviceKey = JSON.parse(environment.SUPABASE_SECRET_KEYS ?? '{}').default ?? environment.SUPABASE_SERVICE_ROLE_KEY;
      const access = await rpc(project, serviceKey, 'gold_scan_context', { scan_token: token });
      if (!access) return new Response(null, { status: 409 });
      const [snapshot, previous] = await Promise.all([
        collect(), access.snapshot ? access.snapshot.sources : fallback()
      ]);
      if (!snapshot.sources.some(source => source.status === 'ok' && source.rows.length)) {
        console.warn('Gold scan returned no current prices', snapshot.sources.map(({ id, reason }) => ({ id, reason })));
        return new Response(null, { status: 503 });
      }
      snapshot.sources = snapshot.sources.map(source => {
        const saved = previous?.find(item => item.id === source.id);
        return source.rows.length || !saved?.rows.length ? source :
          { ...source, status: 'cached', rows: saved.rows, checkedAt: saved.checkedAt };
      });
      const saved = await rpc(project, serviceKey, 'gold_publish', { scan_token: token, new_snapshot: snapshot });
      console.info('Gold scan finished', snapshot.sources.map(({ id, status, reason }) => ({ id, status, reason })));
      return new Response(null, { status: saved ? 204 : 409 });
    } catch {
      console.error('Gold scan could not be completed');
      return new Response(null, { status: 503 });
    }
  };
}
