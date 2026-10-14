'use strict';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function requireMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: `Use ${method} for this endpoint.` });
  return false;
}

function getBearerToken(req) {
  const value = String(req.headers.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function parseRepoSlug(value) {
  const repo = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..')) {
    throw new Error('Repository must be in owner/repo format.');
  }
  const [owner, name] = repo.split('/');
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name.replace(/\.git$/i, ''))}`;
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); }
    catch (_) { return Promise.reject(new Error('Request body must be valid JSON.')); }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) { reject(new Error('Request body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

async function githubJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'actions-tailscale-dashboard',
      ...(options.headers || {})
    },
    cache: 'no-store',
    signal: options.signal || AbortSignal.timeout(20000)
  });
  const raw = response.status === 204 ? '' : await response.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); }
    catch (_) { data = { message: raw.slice(0, 500) }; }
  }
  if (!response.ok) {
    const error = new Error(typeof data.message === 'string' ? data.message : `GitHub API returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return { response, data };
}

function publicErrorMessage(error) {
  if (error && Number.isInteger(error.status)) {
    if (error.status === 401) return 'GitHub rejected this token. Verify the saved GitHub token.';
    if (error.status === 403) return 'GitHub denied this request. Check repository access, Actions permissions, and API rate limits.';
    if (error.status === 404) return 'Repository, workflow, or run was not found, or the token cannot access it.';
  }
  return error && error.message ? error.message : 'Unexpected server error.';
}

module.exports = {
  sendJson,
  noStore,
  requireMethod,
  getBearerToken,
  parseRepoSlug,
  readJsonBody,
  githubJson,
  publicErrorMessage
};
