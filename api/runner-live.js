'use strict';

const crypto = require('node:crypto');
const {
  sendJson, noStore, getBearerToken, parseRepoSlug, readJsonBody,
  githubJson, publicErrorMessage
} = require('../lib/api-helpers');

const TABLE = 'runner_live';
const MAX_PAYLOAD_BYTES = 48 * 1024;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DETAIL_FIELDS = ['cpu', 'cores', 'ram', 'disk', 'os', 'address', 'username', 'password', 'aliveLine'];

function tursoHttpUrl() {
  const raw = String(process.env.TURSO_DATABASE_URL || '').trim();
  if (!raw) return '';
  if (raw.startsWith('libsql://')) return `https://${raw.slice('libsql://'.length).replace(/\/$/, '')}`;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname.endsWith('.turso.io') ? url.origin : '';
  } catch (_) { return ''; }
}

function arg(type, value) { return { type, value: String(value) }; }

async function tursoExecute(sql, args = []) {
  const url = tursoHttpUrl();
  const token = String(process.env.TURSO_AUTH_TOKEN || '').trim();
  if (!url || !token) {
    const error = new Error('Turso is not configured. Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Vercel.');
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args } }, { type: 'close' }] }),
    cache: 'no-store', signal: AbortSignal.timeout(12000)
  });
  let body = {};
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error(`Turso returned HTTP ${response.status}. Check database URL and auth token.`);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  const first = body.results?.[0];
  if (first?.type === 'error') {
    const error = new Error(String(first.error?.message || 'Turso query failed.').slice(0, 300));
    error.status = 502;
    throw error;
  }
  return first?.response?.result || {};
}

async function ensureTable() {
  await tursoExecute(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    k TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function safeDetails(raw) {
  const result = {};
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const field of DETAIL_FIELDS) {
    const value = source[field];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    result[field] = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 500);
  }
  return result;
}

function cleanRecentLines(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-25).map(line => {
    let text = String(line ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, 1000);
    text = text.replace(/(password|passcode|secret|token)(\s*[:=]\s*)[^\s,;]+/ig, '$1$2[REDACTED]');
    return text;
  });
}

function getRunId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new Error('runId must be a positive integer.');
    error.status = 400;
    throw error;
  }
  return id;
}

function cellValue(cell) {
  if (cell == null || cell.type === 'null') return null;
  return Object.prototype.hasOwnProperty.call(cell, 'value') ? cell.value : null;
}

async function fetchRdpStatusFile(repo, runId, githubToken) {
  const paths = [`rdp-status/${runId}.json`, 'rdp-status.json'];
  for (const path of paths) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${githubToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'actions-tailscale-dashboard'
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000)
      });
      if (!response || !response.ok) continue;
      const data = await response.json();
      if (!data || !data.content) continue;
      const raw = Buffer.from(String(data.content).replace(/\s/g, ''), 'base64').toString('utf8');
      const status = JSON.parse(raw);
      if (!status || typeof status !== 'object') continue;
      if (path === 'rdp-status.json' && status.runId && String(status.runId) !== String(runId)) {
        continue;
      }
      return status;
    } catch (_) {
      // Ignore network errors or 404
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for this endpoint.' });
  }

  try {
    const body = await readJsonBody(req, MAX_PAYLOAD_BYTES);
    const action = String(body.action || 'read');
    const repoRaw = String(body.repo || '').trim();
    const repo = parseRepoSlug(repoRaw);
    const runId = getRunId(body.runId);
    const key = `${repoRaw.toLowerCase()}#${runId}`;

    if (action === 'ingest') {
      const expected = String(process.env.RUNNER_INGEST_TOKEN || '').trim();
      if (!expected) {
        const error = new Error('Live runner ingestion is not configured. Set RUNNER_INGEST_TOKEN in Vercel and the same value as a GitHub Actions secret.');
        error.status = 503;
        throw error;
      }
      if (!constantTimeEqual(getBearerToken(req), expected)) {
        const error = new Error('Runner telemetry authentication failed. Check the RUNNER_INGEST_TOKEN GitHub Actions secret.');
        error.status = 401;
        throw error;
      }
      const details = safeDetails(body.details);
      if (!Object.values(details).some(value => value)) {
        const error = new Error('Telemetry contains no runner details. Provide CPU, memory, operating system, or RDP values.');
        error.status = 400;
        throw error;
      }
      const recentLines = cleanRecentLines(body.recentLines);
      const payload = JSON.stringify({ details, recentLines, runNumber: Number(body.runNumber) || null, branch: String(body.branch || '').slice(0, 200), status: String(body.status || 'in_progress').slice(0, 40) });
      if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
        const error = new Error('Telemetry payload is too large.');
        error.status = 413;
        throw error;
      }
      await ensureTable();
      const updatedAt = Date.now();
      await tursoExecute(`INSERT INTO ${TABLE} (k, repo, run_id, payload, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(k) DO UPDATE SET repo=excluded.repo, run_id=excluded.run_id, payload=excluded.payload, updated_at=excluded.updated_at`, [
        arg('text', key), arg('text', repoRaw), arg('integer', runId), arg('text', payload), arg('integer', updatedAt)
      ]);
      // Retain only a short-lived live cache; completed workflow logs remain on GitHub.
      await tursoExecute(`DELETE FROM ${TABLE} WHERE updated_at < ?`, [arg('integer', updatedAt - 24 * 60 * 60 * 1000)]);
      return sendJson(res, 200, { ok: true, stored: true, updatedAt });
    }

    if (action !== 'read') {
      return sendJson(res, 400, { code: 'INVALID_ACTION', message: 'action must be "read" or "ingest".' });
    }

    const githubToken = getBearerToken(req);
    if (!githubToken) return sendJson(res, 401, { code: 'GITHUB_AUTH', message: 'A GitHub token with Actions: read permission is required to read this run.' });
    // Authorize the lookup against GitHub before returning sensitive live RDP data from Turso.
    const { data: run } = await githubJson(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, githubToken);
    if (Number(run.id) !== runId || String(run.repository?.full_name || '').toLowerCase() !== repoRaw.toLowerCase()) {
      return sendJson(res, 403, { code: 'RUN_REPOSITORY_MISMATCH', message: 'GitHub run does not match the requested repository.' });
    }

    let row = null;
    try {
      await ensureTable();
      const result = await tursoExecute(`SELECT payload, updated_at FROM ${TABLE} WHERE k = ?`, [arg('text', key)]);
      row = result.rows?.[0];
    } catch (_) {
      // Turso table may not be initialized yet; fallback to rdp-status file
    }

    if (Array.isArray(row)) {
      const payloadText = cellValue(row[0]);
      const updatedAt = Number(cellValue(row[1])) || 0;
      if (payloadText && updatedAt && Date.now() - updatedAt <= MAX_AGE_MS) {
        let payload;
        try { payload = JSON.parse(String(payloadText)); }
        catch (_) { payload = {}; }
        return sendJson(res, 200, { found: true, source: 'live-telemetry', details: safeDetails(payload.details), recentLines: cleanRecentLines(payload.recentLines), runNumber: payload.runNumber || null, branch: payload.branch || '', status: payload.status || run.status || '', updatedAt });
      }
    }

    // Fallback: check rdp-status/<runId>.json and rdp-status.json from GitHub repository
    const statusFile = await fetchRdpStatusFile(repo, runId, githubToken);
    if (statusFile && (statusFile.address || statusFile.cpu || statusFile.status)) {
      const minLeft = typeof statusFile.restartingIn === 'number' ? statusFile.restartingIn : '?';
      const aliveAt = statusFile.aliveAt || statusFile.updatedAt || '';
      const timeStr = aliveAt ? new Date(aliveAt).toISOString().slice(11, 19) : '';
      const details = safeDetails({
        cpu: statusFile.cpu,
        cores: statusFile.cores,
        ram: statusFile.ram,
        disk: statusFile.disk,
        os: statusFile.os,
        address: statusFile.address,
        username: statusFile.username,
        password: statusFile.password,
        aliveLine: timeStr ? `[${timeStr}] alive — RDP: ${statusFile.address || 'N/A'} | restarting in ${minLeft} min` : (statusFile.address ? `alive — RDP: ${statusFile.address}` : '')
      });
      const recentLines = cleanRecentLines([
        `[rdp-status] Status: ${statusFile.status || 'running'} · Run #${statusFile.runNumber || runId}`,
        `[rdp-status] Host: ${statusFile.os || 'Windows'} · CPU: ${statusFile.cpu || 'N/A'} (${statusFile.cores || ''}) · RAM: ${statusFile.ram || 'N/A'}`,
        `[rdp-status] Disk: ${statusFile.disk || 'N/A'}`,
        `[rdp-status] Session: Address ${statusFile.address || 'N/A'} · Username: ${statusFile.username || 'RDP'}`,
        `[rdp-status] Last keep-alive: ${statusFile.updatedAt || ''} · Auto-restart in ${minLeft} min`
      ]);
      return sendJson(res, 200, {
        found: true,
        source: 'rdp-status-file',
        details,
        recentLines,
        runNumber: Number(statusFile.runNumber) || null,
        branch: '',
        status: statusFile.status || run.status || '',
        updatedAt: new Date(statusFile.updatedAt || Date.now()).getTime()
      });
    }

    return sendJson(res, 200, { found: false, details: {}, recentLines: [], message: 'No live telemetry has been published by this workflow yet. Add the runner telemetry step described in README-RUNNER-LIVE-TELEMETRY.md.' });
  } catch (error) {
    let message = publicErrorMessage(error);
    if (/Runner telemetry authentication failed/.test(error.message || '')) message = error.message;
    else if (/Turso returned HTTP 401/i.test(error.message || '')) message = 'Turso rejected TURSO_AUTH_TOKEN. Generate a valid read/write database token and redeploy.';
    else if (/Turso returned HTTP 403/i.test(error.message || '')) message = 'Turso denied the database request. Check that TURSO_AUTH_TOKEN has read/write permission.';
    return sendJson(res, error.status || 500, { code: 'RUNNER_LIVE_FAILED', message });
  }
};
