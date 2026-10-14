'use strict';

const {
  sendJson, requireMethod, getBearerToken,
  parseRepoSlug, readJsonBody, githubJson, publicErrorMessage
} = require('../lib/api-helpers');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  const token = getBearerToken(req);
  if (!token) return sendJson(res, 401, { code: 'GITHUB_AUTH', message: 'Missing GitHub bearer token.' });

  try {
    const body = await readJsonBody(req);
    const repo = parseRepoSlug(body.repo);
    const runs = [];
    const maxPages = 20;
    let truncated = false;
    for (let page = 1; page <= maxPages; page += 1) {
      const url = `https://api.github.com/repos/${repo}/actions/runs?status=in_progress&per_page=100&page=${page}`;
      const { data } = await githubJson(url, token);
      const batch = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
      runs.push(...batch);
      const total = Number.isFinite(data.total_count) ? data.total_count : runs.length;
      if (batch.length === 0 || runs.length >= total) {
        truncated = runs.length < total;
        break;
      }
      if (page === maxPages) truncated = runs.length < total;
    }
    return sendJson(res, 200, { runs, truncated });
  } catch (error) {
    return sendJson(res, error.status || 400, { code: 'RUNNING_RUNS_FAILED', message: publicErrorMessage(error) });
  }
};
