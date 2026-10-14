'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseRepoSlug } = require('../lib/api-helpers');
const { parseRunnerLog } = require('../lib/runner-log-parser');

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body = '') { this.body = body; }
  };
}

test('repository slugs are validated before calling GitHub', () => {
  assert.equal(parseRepoSlug('octo-org/my-repo'), 'octo-org/my-repo');
  assert.equal(parseRepoSlug('octo-org/my-repo.git'), 'octo-org/my-repo');
  assert.throws(() => parseRepoSlug('https://github.com/octo-org/my-repo'));
  assert.throws(() => parseRepoSlug('../repo'));
});

test('runner log parser extracts fields but redacts secrets from preview', () => {
  const input = [
    'CPU: Intel Xeon', 'Cores: 4', 'RAM: 8 GB', 'Disk (C:): 120 GB',
    'OS: Windows 11', 'RDP Address: 100.64.0.10:3389', 'RDP Username: runner',
    'RDP Password: do-not-show-this-secret', 'alive — RDP: 100.64.0.10:3389'
  ].join('\n');
  const output = parseRunnerLog(input);
  assert.equal(output.details.cpu, 'Intel Xeon');
  assert.equal(output.details.address, '100.64.0.10:3389');
  assert.equal(output.details.password, 'do-not-show-this-secret');
  assert.equal(output.details.aliveLine.includes('RDP'), true);
  assert.equal(output.recentLines.join('\n').includes('do-not-show-this-secret'), false);
});

test('static dashboard includes the new controls and no embedded Turso bearer token', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="btn-dispatch-selected"/);
  assert.match(html, /data-ts-action="approve"/);
  assert.match(html, /id="run-repo-filter"/);
  assert.match(html, /id="run-sort"/);
  assert.match(html, /id="cloud-sync-card"/);
  assert.match(html, /runnerApiFetch\('\/api\/runner-live'/);
  assert.match(html, /live telemetry step/);
  assert.match(html, /id="btn-cloud-connect"/);
  assert.match(html, /Always fetch the canonical state from Turso/);
  assert.doesNotMatch(html, /id="runner-access-key"/);
  assert.doesNotMatch(html, /id="cloud-sync-key"/);
  assert.doesNotMatch(html, /DASHBOARD_ACCESS_KEY/);
  assert.match(html, /CLOUD_SYNC_INTERVAL_MS = 5000/);
  assert.doesNotMatch(html, /TURSO_TOK\s*=\s*['"`]/);
  assert.doesNotMatch(html, /eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9/);
  assert.match(html, /API route \/api\/config was not found/);
});
