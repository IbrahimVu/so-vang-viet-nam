import { randomUUID } from 'node:crypto';

const accessTokenUrl = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const host = 'https://storage.googleapis.com';
const name = 'prices.json';

export function createSnapshotStore(bucket) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket ?? '')) {
    throw new Error('Set GOLD_SNAPSHOT_BUCKET to a valid dedicated bucket name.');
  }
  const base = encodeURIComponent(bucket);
  const metadata = host + '/storage/v1/b/' + base + '/o/' + name;
  let token;
  let expiresAt = 0;

  async function request(url, options = {}) {
    if (!token || expiresAt < Date.now() + 60_000) {
      const response = await fetch(accessTokenUrl, {
        headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) throw new Error('Storage identity unavailable');
      const credentials = await response.json();
      token = credentials.access_token;
      expiresAt = Date.now() + Number(credentials.expires_in) * 1000;
    }
    return fetch(url, {
      ...options, headers: { Authorization: 'Bearer ' + token, ...options.headers },
      redirect: 'error', signal: AbortSignal.timeout(8_000)
    });
  }

  return {
    async read() {
      const response = await request(metadata + '?fields=generation');
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Cannot read snapshot metadata: HTTP ' + response.status);
      const { generation } = await response.json();
      if (!/^\d+$/.test(generation)) throw new Error('Invalid snapshot generation');
      const body = await request(metadata + '?alt=media&generation=' + generation);
      if (!body.ok) throw new Error('Cannot read the saved snapshot: HTTP ' + body.status);
      return { generation, snapshot: await body.json() };
    },

    async write(snapshot, generation) {
      const boundary = 'snapshot-' + randomUUID();
      const metadata = JSON.stringify({ name, contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=30, must-revalidate' });
      const parts = [
        '--' + boundary, 'Content-Type: application/json; charset=utf-8', '', metadata,
        '--' + boundary, 'Content-Type: application/json; charset=utf-8', '', JSON.stringify(snapshot),
        '--' + boundary + '--', ''
      ];
      const target = host + '/upload/storage/v1/b/' + base + '/o?uploadType=multipart&ifGenerationMatch=' + generation;
      const response = await request(target, {
        method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: parts.join('\r\n')
      });
      if (response.status === 412) return false;
      if (!response.ok) throw new Error('Cannot publish the snapshot: HTTP ' + response.status);
      await response.body?.cancel();
      return true;
    }
  };
}
