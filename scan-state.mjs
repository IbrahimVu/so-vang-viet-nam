import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

const branch = 'price-scan-state';
const statePath = 'scan-state.json';
const pauseThreshold = 20;
const timezoneOffset = 7 * 60 * 60_000;

function nextMorning(when) {
  const local = new Date(when.getTime() + timezoneOffset);
  const resume = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 1, 30);
  return new Date(resume > when.getTime() ? resume : resume + 86_400_000).toISOString();
}

export function scanIsPaused(state, when = new Date()) {
  return Date.parse(state?.pausedUntil) > when.getTime();
}

export function scanWindowIsOpen(when = new Date()) {
  const vietnamTime = new Date(when.getTime() + timezoneOffset);
  const minuteOfDay = vietnamTime.getUTCHours() * 60 + vietnamTime.getUTCMinutes();
  return minuteOfDay >= 8 * 60 + 30 && minuteOfDay <= 20 * 60 + 30;
}

export function recordScan(previous, snapshot, when = new Date()) {
  const current = snapshot.sources.filter(source => source.status === 'ok' && !source.partial && source.rows.length);
  const fingerprints = { ...previous?.fingerprints };
  let changed = false;
  for (const source of current) {
    const prices = source.rows.map(row => JSON.stringify([row.region, row.name, row.buy, row.sell])).sort();
    const fingerprint = createHash('sha256').update(JSON.stringify(prices)).digest('hex');
    changed ||= fingerprints[source.id] !== fingerprint;
    fingerprints[source.id] = fingerprint;
  }
  const pausedEarlier = Boolean(previous?.pausedUntil);
  const unchanged = !current.length || changed ? 0 : (pausedEarlier ? 0 : previous?.unchanged ?? 0) + 1;
  return { fingerprints, unchanged, pausedUntil: unchanged >= pauseThreshold ? nextMorning(when) : null };
}

function stateRequest(path, options = {}) {
  const repository = process.env.GITHUB_REPOSITORY;
  return fetch('https://api.github.com/repos/' + repository + '/' + path, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      'Content-Type': 'application/json',
      ...options.headers
    },
    signal: AbortSignal.timeout(12_000)
  });
}

export async function readScanState() {
  const response = await stateRequest('contents/' + statePath + '?ref=' + branch);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Không đọc được trạng thái quét: HTTP ' + response.status);
  const payload = await response.json();
  return { state: JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8')), sha: payload.sha };
}

export async function saveScanState() {
  const state = JSON.parse(process.env.SCAN_STATE_JSON);
  const previous = await readScanState();
  if (!previous) {
    const ref = await stateRequest('git/ref/heads/' + branch);
    if (ref.status === 404) {
      const created = await stateRequest('git/refs', {
        method: 'POST',
        body: JSON.stringify({ ref: 'refs/heads/' + branch, sha: process.env.GITHUB_SHA })
      });
      if (!created.ok) throw new Error('Không tạo được nhánh trạng thái quét: HTTP ' + created.status);
    } else if (!ref.ok) {
      throw new Error('Không kiểm tra được nhánh trạng thái quét: HTTP ' + ref.status);
    }
  }

  const response = await stateRequest('contents/' + statePath, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'Save gold price scan state',
      branch,
      sha: previous?.sha,
      content: Buffer.from(JSON.stringify(state, null, 2) + '\n').toString('base64')
    })
  });
  if (!response.ok) throw new Error('Không lưu được trạng thái quét: HTTP ' + response.status);
}

export async function workflowOutput(publish, state = null) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, 'publish=' + publish + '\nscan_state=' +
      (state ? JSON.stringify(state) : '') + '\n');
  }
}
