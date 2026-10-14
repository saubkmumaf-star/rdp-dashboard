'use strict';

const { sendJson, noStore } = require('../lib/api-helpers');

module.exports = async function handler(req, res) {
  noStore(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, message: 'Use GET for this endpoint.' });
  }
  // Diagnostic only: report configuration presence, never values or secrets.
  return sendJson(res, 200, {
    ok: true,
    service: 'actions-tailscale-dashboard',
    routes: { config: true, health: true, runnerLive: true, runLog: true },
    environment: {
      tursoDatabaseUrlConfigured: Boolean(String(process.env.TURSO_DATABASE_URL || '').trim()),
      tursoAuthTokenConfigured: Boolean(String(process.env.TURSO_AUTH_TOKEN || '').trim()),
      runnerIngestTokenConfigured: Boolean(String(process.env.RUNNER_INGEST_TOKEN || '').trim())
    }
  });
};
