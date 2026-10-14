'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../api/config');

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') { this.body = value; }
  };
}

const textCell = value => value == null ? { type: 'null' } : { type: 'text', value: String(value) };
const intCell = value => ({ type: 'integer', value: String(value) });

function fakeTurso({ configState = null, previousSharedState = null } = {}) {
  let row = configState ? { k: 'gha-dashboard', v: JSON.stringify(configState), revision: 1, updated_at: 0 } : null;
  let previous = previousSharedState ? { k: 'gha-dashboard', v: JSON.stringify(previousSharedState), revision: 7, updated_at: 1700000000000 } : null;
  return async (url, options) => {
    assert.match(String(url), /\.turso\.io\/v2\/pipeline$/);
    assert.equal(options.headers.Authorization, 'Bearer fresh-test-turso-token');
    const body = JSON.parse(options.body);
    const request = body.requests[0];
    const sql = request.stmt.sql;
    const args = request.stmt.args || [];
    const arg = i => args[i]?.value;
    let result = { cols: [], rows: [], affected_row_count: 0 };

    if (/CREATE TABLE IF NOT EXISTS cfg/i.test(sql) || /ALTER TABLE cfg ADD COLUMN/i.test(sql)) {
      // Existing cfg(k, v) schema is upgraded in place in production.
    } else if (/SELECT v, revision, updated_at FROM cfg/i.test(sql)) {
      if (row) result.rows = [[textCell(row.v), intCell(row.revision), intCell(row.updated_at)]];
    } else if (/SELECT v, revision, updated_at FROM dashboard_shared_config/i.test(sql)) {
      if (previous) result.rows = [[textCell(previous.v), intCell(previous.revision), intCell(previous.updated_at)]];
      else return new Response(JSON.stringify({ results: [{ type: 'error', error: { message: 'no such table: dashboard_shared_config' } }] }), { status: 200 });
    } else if (/INSERT OR IGNORE INTO cfg/i.test(sql)) {
      if (!row) row = { k: String(arg(0)), v: String(arg(1)), revision: Number(arg(2)) || 1, updated_at: Number(arg(3)) || 0 };
    } else if (/INSERT INTO cfg/i.test(sql)) {
      const key = String(arg(0));
      const value = String(arg(1));
      const now = Number(arg(2));
      const expected = Number(arg(3));
      if (!row) row = { k: key, v: value, revision: 1, updated_at: now };
      else if (row.revision === expected) row = { k: key, v: value, revision: row.revision + 1, updated_at: now };
    } else if (/INSERT INTO dashboard_shared_config/i.test(sql)) {
      if (!previous) return new Response(JSON.stringify({ results: [{ type: 'error', error: { message: 'no such table: dashboard_shared_config' } }] }), { status: 200 });
      previous = { k: String(arg(0)), v: String(arg(1)), revision: Number(arg(2)), updated_at: Number(arg(3)) };
    } else {
      throw new Error(`Unexpected SQL in test: ${sql}`);
    }

    return new Response(JSON.stringify({ results: [
      { type: 'ok', response: { type: 'execute', result } },
      { type: 'ok', response: { type: 'close' } }
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function setupEnv(t) {
  const old = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN, fetch: global.fetch };
  process.env.TURSO_DATABASE_URL = 'https://test-db.aws-us-east-1.turso.io';
  process.env.TURSO_AUTH_TOKEN = 'fresh-test-turso-token';
  t.after(() => {
    global.fetch = old.fetch;
    if (old.url === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = old.url;
    if (old.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = old.token;
  });
  return old;
}

test('config route auto-loads cfg from server-side Turso environment variables without a browser key', async t => {
  setupEnv(t);
  global.fetch = fakeTurso();
  const res = responseRecorder();
  await config({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).found, false);
});

test('config route loads cfg JSON and revision-checks automatic key/config updates', async t => {
  setupEnv(t);
  const legacy = { tokens: { gh1: { name: 'GitHub', token: 'test-github-token' } }, repos: [{ id: 'r1', repo: 'owner/first' }], activeRepo: 'r1', settings: { interval: 15 }, tailscale: { token: 'test-tailscale-token', tailnet: '-' } };
  global.fetch = fakeTurso({ configState: legacy });

  const first = responseRecorder();
  await config({ method: 'GET', headers: {} }, first);
  assert.equal(first.statusCode, 200);
  const loaded = JSON.parse(first.body);
  assert.equal(loaded.found, true);
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.state.repos[0].repo, 'owner/first');
  assert.equal(loaded.state.tokens.gh1.token, 'test-github-token');

  const changed = { ...legacy, tokens: { ...legacy.tokens, gh1: { name: 'GitHub', token: 'rotated-github-token' } }, repos: [...legacy.repos, { id: 'r2', repo: 'owner/second' }] };
  const update = responseRecorder();
  await config({ method: 'PUT', headers: {}, body: { state: changed, expectedRevision: 1 } }, update);
  assert.equal(update.statusCode, 200);
  assert.equal(JSON.parse(update.body).revision, 2);
  assert.equal(JSON.parse(update.body).state.tokens.gh1.token, 'rotated-github-token');

  const stale = responseRecorder();
  await config({ method: 'PUT', headers: {}, body: { state: legacy, expectedRevision: 1 } }, stale);
  assert.equal(stale.statusCode, 409);
  assert.equal(JSON.parse(stale.body).code, 'CONFIG_CONFLICT');
  assert.equal(JSON.parse(stale.body).revision, 2);
});

test('config route imports the previous shared table if cfg has no state yet', async t => {
  setupEnv(t);
  const previous = { tokens: {}, repos: [{ id: 'r-old', repo: 'owner/previous' }], activeRepo: 'r-old', settings: { interval: 15 }, tailscale: { token: '', tailnet: '-' } };
  global.fetch = fakeTurso({ previousSharedState: previous });
  const res = responseRecorder();
  await config({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.found, true);
  assert.equal(payload.state.repos[0].repo, 'owner/previous');
});
