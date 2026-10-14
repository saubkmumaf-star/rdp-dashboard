'use strict';

const { sendJson, noStore, getBearerToken } = require('../lib/api-helpers');

function getPath(req) {
  const raw = typeof req.query?.path === 'string' ? req.query.path : '';
  if (!raw || raw.length > 1800 || !raw.startsWith('/api/v2/') || raw.includes('\\') || /\s/.test(raw)) return '';
  let parsed;
  try { parsed = new URL(raw, 'https://api.tailscale.com'); }
  catch (_) { return ''; }
  if (parsed.origin !== 'https://api.tailscale.com' || parsed.pathname.includes('..')) return '';
  const allowed = /^\/api\/v2\/(?:tailnet\/[^/]+\/devices|device\/[^/]+(?:\/(?:authorized|name|ip|key|tags|routes))?)\/?$/;
  if (!allowed.test(parsed.pathname)) return '';
  return parsed.pathname + parsed.search;
}

module.exports = async function handler(req, res) {
  noStore(res);
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Only GET, POST, and DELETE are supported.' });
  }
  const token = getBearerToken(req);
  if (!token) return sendJson(res, 401, { code: 'TAILSCALE_AUTH', message: 'Missing Tailscale API bearer token.' });
  const path = getPath(req);
  if (!path) return sendJson(res, 400, { code: 'INVALID_PATH', message: 'Unsupported Tailscale API path.' });
  if (req.method === 'POST' && /\/authorized$/.test(path)) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.authorized !== true) return sendJson(res, 400, { code: 'INVALID_APPROVAL', message: 'Device approval requires authorized: true.' });
  }

  try {
    const upstream = await fetch(`https://api.tailscale.com${path}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {})
      },
      ...(req.method === 'POST' ? { body: JSON.stringify(req.body || {}) } : {}),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000)
    });
    const text = upstream.status === 204 ? '' : await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    if (text) res.end(text); else res.end();
  } catch (error) {
    return sendJson(res, 502, { code: 'TAILSCALE_UPSTREAM', message: `Could not reach Tailscale API: ${error.name === 'TimeoutError' ? 'request timed out' : 'network error'}.` });
  }
};
