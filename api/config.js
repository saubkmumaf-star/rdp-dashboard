'use strict';

const {
  sendJson,
  noStore,
  readJsonBody
} = require('../lib/api-helpers');

const CONFIG_KEY = 'gha-dashboard';
const TABLE = 'cfg';
const PREVIOUS_TABLE = 'dashboard_shared_config';
let tableReadyPromise = null;

function databaseUrl() {
  const raw = String(process.env.TURSO_DATABASE_URL || '').trim();
  if (!raw) return '';
  if (raw.startsWith('libsql://')) return `https://${raw.slice('libsql://'.length).replace(/\/$/, '')}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.turso.io')) return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

function cellValue(cell) {
  if (cell == null || cell.type === 'null') return null;
  return Object.prototype.hasOwnProperty.call(cell, 'value') ? cell.value : null;
}

function firstRow(result) {
  const row = result?.rows?.[0];
  return Array.isArray(row) ? row.map(cellValue) : null;
}

async function tursoQuery(sql, args = []) {
  const url = databaseUrl();
  const token = String(process.env.TURSO_AUTH_TOKEN || '').trim();
  if (!url || !token) {
    const error = new Error('Turso is not configured. Set TURSO_DATABASE_URL and a newly rotated TURSO_AUTH_TOKEN in Vercel Environment Variables.');
    error.status = 503;
    throw error;
  }

  const response = await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args } }, { type: 'close' }] }),
    cache: 'no-store',
    signal: AbortSignal.timeout(15000)
  });
  let body = {};
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error(`Turso returned HTTP ${response.status}. Check the database URL and rotated auth token.`);
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

async function addColumnIfMissing(sql) {
  try {
    await tursoQuery(sql);
  } catch (error) {
    if (!/duplicate column name|already exists/i.test(error.message || '')) throw error;
  }
}

async function ensureTable() {
  if (!tableReadyPromise) {
    tableReadyPromise = (async () => {
      // Keep the user's existing cfg(k, v) table and preserve the exact
      // JSON state shape. Add metadata columns in place for safe revision checks.
      await tursoQuery(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`);
      await addColumnIfMissing('ALTER TABLE cfg ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
      await addColumnIfMissing('ALTER TABLE cfg ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
    })().catch(error => {
      tableReadyPromise = null;
      throw error;
    });
  }
  await tableReadyPromise;
}

function parseStoredState(row) {
  if (!row) return null;
  let state;
  try { state = JSON.parse(String(row[0] || 'null')); }
  catch (_) {
    const error = new Error('Stored dashboard data is not valid JSON. Keep a backup before changing the database.');
    error.status = 500;
    throw error;
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    const error = new Error('Stored dashboard data has an invalid format.');
    error.status = 500;
    throw error;
  }
  return { state, revision: Number(row[1]) || 1, updatedAt: Number(row[2]) || 0 };
}

async function readRow() {
  const result = await tursoQuery(`SELECT v, revision, updated_at FROM ${TABLE} WHERE k = ?`, [
    { type: 'text', value: CONFIG_KEY }
  ]);
  return parseStoredState(firstRow(result));
}

async function readPreviousSharedRow() {
  try {
    const result = await tursoQuery(`SELECT v, revision, updated_at FROM ${PREVIOUS_TABLE} WHERE k = ?`, [
      { type: 'text', value: CONFIG_KEY }
    ]);
    return parseStoredState(firstRow(result));
  } catch (error) {
    // This table only existed in a previous version of the dashboard.
    if (/no such table|does not exist/i.test(error.message || '')) return null;
    throw error;
  }
}

async function migratePreviousSharedTable() {
  // If cfg has not been seeded but a previous dashboard version used the
  // dashboard_shared_config table, copy the state back into cfg once.
  const previous = await readPreviousSharedRow();
  if (!previous) return null;
  await tursoQuery(`INSERT OR IGNORE INTO ${TABLE} (k, v, revision, updated_at) VALUES (?, ?, ?, ?)`, [
    { type: 'text', value: CONFIG_KEY },
    { type: 'text', value: JSON.stringify(previous.state) },
    { type: 'integer', value: String(previous.revision || 1) },
    { type: 'integer', value: String(previous.updatedAt || Date.now()) }
  ]);
  return readRow();
}

async function mirrorPreviousTable(current) {
  // Keep data in the original cfg row as the canonical record. If a previous
  // release's table exists, mirror writes there for a gradual rollout, without
  // failing the canonical save if that optional table is absent.
  try {
    await tursoQuery(`INSERT INTO ${PREVIOUS_TABLE} (k, v, revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(k) DO UPDATE SET
        v = excluded.v,
        revision = excluded.revision,
        updated_at = excluded.updated_at`, [
      { type: 'text', value: CONFIG_KEY },
      { type: 'text', value: JSON.stringify(current.state) },
      { type: 'integer', value: String(current.revision) },
      { type: 'integer', value: String(current.updatedAt) }
    ]);
  } catch (error) {
    if (!/no such table|does not exist/i.test(error.message || '')) throw error;
  }
}

function stateFromBody(body) {
  if (!body || !body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
    const error = new Error('Request must include a dashboard state object.');
    error.status = 400;
    throw error;
  }
  const serialized = JSON.stringify(body.state);
  if (serialized.length > 512 * 1024) {
    const error = new Error('Dashboard state exceeds the 512 KiB size limit. Remove excess configuration and try again.');
    error.status = 413;
    throw error;
  }
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    const error = new Error('expectedRevision must be a non-negative integer.');
    error.status = 400;
    throw error;
  }
  return { serialized, expectedRevision };
}

module.exports = async function handler(req, res) {
  noStore(res);
  if (!['GET', 'PUT'].includes(req.method)) {
    res.setHeader('Allow', 'GET, PUT');
    return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and PUT are supported.' });
  }

  try {
    await ensureTable();
    let current = await readRow();
    if (!current) current = await migratePreviousSharedTable();

    if (req.method === 'GET') {
      return sendJson(res, 200, current
        ? { found: true, ...current }
        : { found: false, state: null, revision: 0, updatedAt: 0 });
    }

    const body = await readJsonBody(req, 512 * 1024);
    const { serialized, expectedRevision } = stateFromBody(body);
    const now = Date.now();
    await tursoQuery(`INSERT INTO ${TABLE} (k, v, revision, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(k) DO UPDATE SET
        v = excluded.v,
        revision = ${TABLE}.revision + 1,
        updated_at = excluded.updated_at
      WHERE ${TABLE}.revision = ?`, [
      { type: 'text', value: CONFIG_KEY },
      { type: 'text', value: serialized },
      { type: 'integer', value: String(now) },
      { type: 'integer', value: String(expectedRevision) }
    ]);

    current = await readRow();
    if (current && current.revision === expectedRevision + 1 && JSON.stringify(current.state) === serialized) {
      await mirrorPreviousTable(current);
      return sendJson(res, 200, { found: true, ...current });
    }
    return sendJson(res, 409, {
      code: 'CONFIG_CONFLICT',
      message: 'Another browser updated the shared dashboard. Latest state is included for a safe merge.',
      found: Boolean(current),
      ...(current || { state: null, revision: 0, updatedAt: 0 })
    });
  } catch (error) {
    const inferredStatus = /too large/i.test(error.message || '') ? 413 : /valid JSON/i.test(error.message || '') ? 400 : 502;
    const status = Number.isInteger(error.status) ? error.status : inferredStatus;
    return sendJson(res, status, {
      code: status === 503 ? 'TURSO_CONFIG' : status === 400 ? 'INVALID_REQUEST' : status === 413 ? 'BODY_TOO_LARGE' : status === 409 ? 'CONFIG_CONFLICT' : 'TURSO_ERROR',
      message: String(error.message || 'Shared database request failed.').slice(0, 500)
    });
  }
};
