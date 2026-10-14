'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runningRuns = require('../api/running-runs');
const tailscale = require('../api/tailscale');

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') { this.body = value; }
  };
}


test('running-runs works without a per-page dashboard key and returns active workflow runs', async () => {
  const oldFetch = global.fetch;
  let target = '';
  global.fetch = async (url) => {
    target = String(url);
    return new Response(JSON.stringify({ total_count: 1, workflow_runs: [{ id: 42, status: 'in_progress' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = responseRecorder();
    await runningRuns({ method: 'POST', headers: { authorization: 'Bearer github-test-token' }, body: { repo: 'octo-org/project' } }, res);
    assert.equal(res.statusCode, 200);
    assert.match(target, /api\.github\.com\/repos\/octo-org\/project\/actions\/runs/);
    assert.equal(JSON.parse(res.body).runs[0].id, 42);
  } finally {
    global.fetch = oldFetch;
  }
});

test('keyless Tailscale proxy only forwards supported same-origin device endpoints', async () => {
  const oldFetch = global.fetch;
  let target = '';
  global.fetch = async (url, options) => {
    target = String(url);
    assert.equal(options.headers.Authorization, 'Bearer tskey-api-test');
    return new Response(JSON.stringify({ devices: [{ id: 'device-1' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = responseRecorder();
    await tailscale({ method: 'GET', query: { path: '/api/v2/tailnet/-/devices' }, headers: { authorization: 'Bearer tskey-api-test' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(target, 'https://api.tailscale.com/api/v2/tailnet/-/devices');
    assert.equal(JSON.parse(res.body).devices[0].id, 'device-1');

    const invalid = responseRecorder();
    await tailscale({ method: 'GET', query: { path: 'https://example.com/steal' }, headers: { authorization: 'Bearer tskey-api-test' } }, invalid);
    assert.equal(invalid.statusCode, 400);
  } finally {
    global.fetch = oldFetch;
  }
});

test('Tailscale approval forwards only authorized=true', async () => {
  const oldFetch = global.fetch;
  let forwardedBody = null;
  global.fetch = async (_url, options) => {
    forwardedBody = JSON.parse(options.body);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const rejected = responseRecorder();
    await tailscale({ method: 'POST', query: { path: '/api/v2/device/device-1/authorized' }, headers: { authorization: 'Bearer tskey-api-test' }, body: { authorized: false } }, rejected);
    assert.equal(rejected.statusCode, 400);
    assert.equal(forwardedBody, null);

    const accepted = responseRecorder();
    await tailscale({ method: 'POST', query: { path: '/api/v2/device/device-1/authorized' }, headers: { authorization: 'Bearer tskey-api-test' }, body: { authorized: true } }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(forwardedBody, { authorized: true });
  } finally {
    global.fetch = oldFetch;
  }
});


test('health endpoint reports configuration presence without secrets', async () => {
  const handler = require('../api/health');
  const oldUrl = process.env.TURSO_DATABASE_URL;
  const oldToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = 'https://example.aws-ap-south-1.turso.io';
  process.env.TURSO_AUTH_TOKEN = 'test-secret-never-return-this';
  const req = { method: 'GET', headers: {} };
  const res = responseRecorder();
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.environment.tursoDatabaseUrlConfigured, true);
    assert.equal(payload.environment.tursoAuthTokenConfigured, true);
    assert.equal(res.body.includes('test-secret-never-return-this'), false);
  } finally {
    if (oldUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = oldUrl;
    if (oldToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = oldToken;
  }
});

const runnerLive = require('../api/runner-live');

test('runner-live ingest is token-protected and stores current telemetry in Turso', async () => {
  const oldFetch = global.fetch;
  const oldDbUrl = process.env.TURSO_DATABASE_URL;
  const oldDbToken = process.env.TURSO_AUTH_TOKEN;
  const oldIngestToken = process.env.RUNNER_INGEST_TOKEN;
  process.env.TURSO_DATABASE_URL = 'https://test-db.aws-us-east-1.turso.io';
  process.env.TURSO_AUTH_TOKEN = 'turso-test-token';
  process.env.RUNNER_INGEST_TOKEN = 'runner-ingest-test-token';
  const executedSql = [];
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://test-db.aws-us-east-1.turso.io/v2/pipeline');
    const request = JSON.parse(options.body).requests[0];
    executedSql.push(request.stmt.sql);
    return new Response(JSON.stringify({ results: [{ type: 'ok', response: { result: { rows: [], affected_row_count: 1 } } }, { type: 'ok', response: { result: {} } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const denied = responseRecorder();
    await runnerLive({ method: 'POST', headers: { authorization: 'Bearer wrong-token' }, body: { action: 'ingest', repo: 'octo-org/project', runId: 42, details: { cpu: 'test CPU' } } }, denied);
    assert.equal(denied.statusCode, 401);

    const res = responseRecorder();
    await runnerLive({ method: 'POST', headers: { authorization: 'Bearer runner-ingest-test-token' }, body: { action: 'ingest', repo: 'octo-org/project', runId: 42, details: { cpu: 'Test CPU', password: 'hidden-secret' }, recentLines: ['RDP Password: hidden-secret'] } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).stored, true);
    assert.equal(executedSql.some(sql => /CREATE TABLE IF NOT EXISTS runner_live/.test(sql)), true);
    assert.equal(executedSql.some(sql => /INSERT INTO runner_live/.test(sql)), true);
    assert.equal(executedSql.some(sql => /DELETE FROM runner_live/.test(sql)), true);
  } finally {
    global.fetch = oldFetch;
    if (oldDbUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = oldDbUrl;
    if (oldDbToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = oldDbToken;
    if (oldIngestToken === undefined) delete process.env.RUNNER_INGEST_TOKEN; else process.env.RUNNER_INGEST_TOKEN = oldIngestToken;
  }
});

test('runner-live read requires GitHub repository access and returns matching run telemetry', async () => {
  const oldFetch = global.fetch;
  const oldDbUrl = process.env.TURSO_DATABASE_URL;
  const oldDbToken = process.env.TURSO_AUTH_TOKEN;
  process.env.TURSO_DATABASE_URL = 'libsql://test-db.aws-us-east-1.turso.io';
  process.env.TURSO_AUTH_TOKEN = 'turso-test-token';
  const updatedAt = Date.now();
  const payload = JSON.stringify({ details: { cpu: 'Test CPU', ram: '8 GB' }, recentLines: [], status: 'in_progress' });
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.github.com/')) {
      assert.match(String(url), /actions\/runs\/42$/);
      return new Response(JSON.stringify({ id: 42, status: 'in_progress', repository: { full_name: 'octo-org/project' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const first = JSON.parse(options.body).requests[0];
    let result = { rows: [], affected_row_count: 0 };
    if (/SELECT payload, updated_at FROM runner_live/.test(first.stmt.sql)) {
      result = { rows: [[{ type: 'text', value: payload }, { type: 'integer', value: String(updatedAt) }]] };
    }
    return new Response(JSON.stringify({ results: [{ type: 'ok', response: { result } }, { type: 'ok', response: { result: {} } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = responseRecorder();
    await runnerLive({ method: 'POST', headers: { authorization: 'Bearer github-read-token' }, body: { action: 'read', repo: 'octo-org/project', runId: 42 } }, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.found, true);
    assert.equal(body.details.cpu, 'Test CPU');
    assert.equal(body.details.ram, '8 GB');
  } finally {
    global.fetch = oldFetch;
    if (oldDbUrl === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = oldDbUrl;
    if (oldDbToken === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = oldDbToken;
  }
});

test('run-log explains that active GitHub workflow logs are unavailable until live telemetry is published', async () => {
  const runLog = require('../api/run-log');
  const oldFetch = global.fetch;
  global.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/actions/runs/42/logs')) return new Response('Not found', { status: 404 });
    if (value.endsWith('/actions/runs/42/jobs?per_page=100')) return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (value.endsWith('/actions/runs/42')) return new Response(JSON.stringify({ id: 42, status: 'in_progress', repository: { full_name: 'octo-org/project' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`Unexpected mocked URL: ${value}`);
  };
  try {
    const res = responseRecorder();
    await runLog({ method: 'POST', headers: { authorization: 'Bearer github-test-token' }, body: { repo: 'octo-org/project', runId: 42 } }, res);
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'RUN_LOGS_NOT_READY');
    assert.match(body.message, /Live Runner Telemetry step/);
  } finally {
    global.fetch = oldFetch;
  }
});

test('run-log loads live RDP details from rdp-status/{runId}.json file in the repository', async () => {
  const runLog = require('../api/run-log');
  const oldFetch = global.fetch;
  const mockStatus = {
    runId: '99',
    runNumber: '5',
    status: 'running',
    address: '100.91.184.108',
    username: 'RDP',
    password: 'rakib123',
    cpu: 'Intel Xeon Platinum',
    cores: '2 cores / 4 threads',
    ram: '16 GB',
    disk: '150 GB total',
    os: 'Windows Server 2025',
    updatedAt: '2026-10-14T14:46:45Z',
    restartingIn: 290
  };
  const b64 = Buffer.from(JSON.stringify(mockStatus)).toString('base64');
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/contents/rdp-status/99.json')) {
      return new Response(JSON.stringify({ content: b64 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  try {
    const res = responseRecorder();
    await runLog({ method: 'POST', headers: { authorization: 'Bearer test-token' }, body: { repo: 'safwasf/rdpv1', runId: 99 } }, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.source, 'rdp-status-file');
    assert.equal(body.details.address, '100.91.184.108');
    assert.equal(body.details.username, 'RDP');
    assert.equal(body.details.password, 'rakib123');
    assert.equal(body.details.cpu, 'Intel Xeon Platinum');
    assert.match(body.details.aliveLine, /100\.91\.184\.108/);
  } finally {
    global.fetch = oldFetch;
  }
});

test('runner-live read falls back to rdp-status/{runId}.json when Turso is not populated', async () => {
  const runnerLive = require('../api/runner-live');
  const oldFetch = global.fetch;
  const mockStatus = {
    runId: '101',
    status: 'running',
    address: '100.64.0.1',
    username: 'RDP',
    password: 'secretPassword',
    cpu: 'AMD EPYC',
    updatedAt: '2026-10-14T15:00:00Z'
  };
  const b64 = Buffer.from(JSON.stringify(mockStatus)).toString('base64');
  global.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('/actions/runs/101')) {
      return new Response(JSON.stringify({ id: 101, status: 'in_progress', repository: { full_name: 'test/repo' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value.includes('/contents/rdp-status/101.json')) {
      return new Response(JSON.stringify({ content: b64 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  try {
    const res = responseRecorder();
    await runnerLive({ method: 'POST', headers: { authorization: 'Bearer test-token' }, body: { action: 'read', repo: 'test/repo', runId: 101 } }, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.found, true);
    assert.equal(body.source, 'rdp-status-file');
    assert.equal(body.details.address, '100.64.0.1');
    assert.equal(body.details.username, 'RDP');
    assert.equal(body.details.password, 'secretPassword');
    assert.equal(body.details.cpu, 'AMD EPYC');
  } finally {
    global.fetch = oldFetch;
  }
});

