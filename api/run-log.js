'use strict';

const JSZip = require('jszip');
const {
  sendJson, requireMethod, getBearerToken,
  parseRepoSlug, readJsonBody, githubJson, publicErrorMessage
} = require('../lib/api-helpers');
const { parseRunnerLog } = require('../lib/runner-log-parser');

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const GH = 'https://api.github.com';

async function readLimited(response, maxBytes) {
  const stated = Number(response.headers.get('content-length') || 0);
  if (stated > maxBytes) throw new Error(`Workflow logs exceed the ${Math.round(maxBytes / 1024 / 1024)} MiB safety limit.`);
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('Workflow logs are too large.');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Workflow logs exceed the safety limit.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'actions-tailscale-dashboard'
  };
}

async function followGitHubLogRedirect(response) {
  const location = response.headers.get('location');
  if (!location || ![301, 302, 303, 307, 308].includes(response.status)) {
    if (response.ok) return response;
    return null;
  }
  let signedUrl;
  try { signedUrl = new URL(location); }
  catch (_) { return null; }
  if (signedUrl.protocol !== 'https:') return null;
  // GitHub's signed download URL is already authorized; do not forward the GitHub token to it.
  const downloaded = await fetch(signedUrl, { cache: 'no-store', signal: AbortSignal.timeout(25000) });
  return downloaded.ok ? downloaded : null;
}

async function getRunArchive(repo, runId, token) {
  const response = await fetch(`${GH}/repos/${repo}/actions/runs/${runId}/logs`, {
    headers: githubHeaders(token), redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20000)
  });
  const downloaded = await followGitHubLogRedirect(response);
  if (!downloaded) return { ok: false, status: response.status };
  const archive = await readLimited(downloaded, MAX_ARCHIVE_BYTES);
  const zip = await JSZip.loadAsync(archive, { checkCRC32: false, createFolders: false });
  const files = Object.values(zip.files).filter(file => !file.dir && /\.(?:txt|log)$/i.test(file.name)).slice(0, 200);
  let combined = '';
  for (const file of files) {
    const remaining = MAX_TEXT_BYTES - Buffer.byteLength(combined, 'utf8');
    if (remaining <= 0) break;
    const advertisedSize = Number(file._data && file._data.uncompressedSize);
    if (Number.isFinite(advertisedSize) && advertisedSize > remaining) continue;
    const text = await file.async('string');
    if (Buffer.byteLength(text, 'utf8') > remaining) continue;
    combined += `\n--- ${file.name} ---\n${text}`;
  }
  return { ok: true, text: combined, source: 'run-archive' };
}

async function getIndividualJobLogs(repo, runId, token) {
  const { data } = await githubJson(`${GH}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, token);
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const chunks = [];
  let total = 0;
  // Prefer completed jobs because GitHub often does not expose a live job log until it finishes.
  const ordered = jobs.filter(job => job.status === 'completed');
  for (const job of ordered.slice(0, 50)) {
    if (!Number.isSafeInteger(Number(job.id)) || Number(job.id) <= 0) continue;
    try {
      const response = await fetch(`${GH}/repos/${repo}/actions/jobs/${Number(job.id)}/logs`, {
        headers: githubHeaders(token), redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000)
      });
      const downloaded = await followGitHubLogRedirect(response);
      if (!downloaded) continue;
      const buffer = await readLimited(downloaded, Math.min(MAX_TEXT_BYTES, MAX_ARCHIVE_BYTES));
      // Job-log endpoint returns plain text; a ZIP response is ignored and the run-archive path is preferred.
      const text = buffer.toString('utf8');
      if (!text || text.startsWith('PK\u0003\u0004') || text.includes('\u0000')) continue;
      const remaining = MAX_TEXT_BYTES - total;
      if (remaining <= 0) break;
      chunks.push(`\n--- job ${job.name || job.id} (${job.status || 'unknown'}) ---\n${text.slice(0, remaining)}`);
      total += Buffer.byteLength(chunks[chunks.length - 1], 'utf8');
    } catch (_) {
      // A single unavailable/in-progress job must not prevent other jobs from loading.
    }
  }
  const combined = chunks.join('');
  return combined.trim() ? { ok: true, text: combined, source: 'job-logs' } : { ok: false, status: 404 };
}

async function fetchRdpStatusFile(repo, runId, token) {
  const paths = [`rdp-status/${runId}.json`, 'rdp-status.json'];
  for (const path of paths) {
    try {
      const response = await fetch(`${GH}/repos/${repo}/contents/${path}`, {
        headers: githubHeaders(token),
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
      // Ignore 404 or missing mocked route in tests
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  const token = getBearerToken(req);
  if (!token) return sendJson(res, 401, { code: 'GITHUB_AUTH', message: 'Missing GitHub bearer token.' });
  try {
    const body = await readJsonBody(req);
    const repo = parseRepoSlug(body.repo);
    const runId = Number(body.runId);
    if (!Number.isSafeInteger(runId) || runId <= 0) return sendJson(res, 400, { code: 'INVALID_RUN_ID', message: 'runId must be a positive integer.' });

    // 1. Check for live rdp-status file committed to the repository by the workflow
    const statusFile = await fetchRdpStatusFile(repo, runId, token);
    if (statusFile && (statusFile.address || statusFile.cpu || statusFile.status)) {
      const minLeft = typeof statusFile.restartingIn === 'number' ? statusFile.restartingIn : '?';
      const aliveAt = statusFile.aliveAt || statusFile.updatedAt || '';
      const timeStr = aliveAt ? new Date(aliveAt).toISOString().slice(11, 19) : '';
      const aliveLine = timeStr
        ? `[${timeStr}] alive — RDP: ${statusFile.address || 'N/A'} | restarting in ${minLeft} min`
        : (statusFile.address ? `alive — RDP: ${statusFile.address}` : '');
      return sendJson(res, 200, {
        details: {
          cpu: String(statusFile.cpu || ''),
          cores: String(statusFile.cores || ''),
          ram: String(statusFile.ram || ''),
          disk: String(statusFile.disk || ''),
          os: String(statusFile.os || ''),
          address: String(statusFile.address || ''),
          username: String(statusFile.username || ''),
          password: String(statusFile.password || ''),
          aliveLine
        },
        recentLines: [
          `[rdp-status] Status: ${statusFile.status || 'running'} · Run #${statusFile.runNumber || runId}`,
          `[rdp-status] Host: ${statusFile.os || 'Windows'} · CPU: ${statusFile.cpu || 'N/A'} (${statusFile.cores || ''}) · RAM: ${statusFile.ram || 'N/A'}`,
          `[rdp-status] Disk: ${statusFile.disk || 'N/A'}`,
          `[rdp-status] Session: Address ${statusFile.address || 'N/A'} · Username: ${statusFile.username || 'RDP'}`,
          `[rdp-status] Last keep-alive: ${statusFile.updatedAt || ''} · Auto-restart in ${minLeft} min`
        ],
        source: 'rdp-status-file'
      });
    }

    let logResult;
    let archiveError = null;
    try { logResult = await getRunArchive(repo, runId, token); }
    catch (error) { archiveError = error; logResult = { ok: false, status: error.status || 502 }; }
    const archiveStatus = Number(logResult.status) || 0;

    if (!logResult.ok) {
      try { logResult = await getIndividualJobLogs(repo, runId, token); }
      catch (error) { if (!archiveError) archiveError = error; logResult = { ok: false, status: error.status || 502 }; }
    }

    if (!logResult.ok) {
      const permissionStatus = [401, 403].includes(archiveStatus) ? archiveStatus : ([401, 403].includes(archiveError?.status) ? archiveError.status : 0);
      if (permissionStatus) {
        const message = permissionStatus === 401
          ? 'GitHub rejected this token. Verify the saved GitHub token.'
          : 'GitHub denied workflow logs. The token needs Actions: read permission and repository access.';
        return sendJson(res, permissionStatus, { code: 'RUN_LOG_PERMISSION_DENIED', message });
      }
      // Ask GitHub for run metadata so a missing live archive is not confused with bad Turso config.
      let run = null;
      try {
        const result = await githubJson(`${GH}/repos/${repo}/actions/runs/${runId}`, token);
        run = result.data;
      } catch (error) {
        if ([401, 403, 404].includes(error.status)) {
          const message = error.status === 401
            ? 'GitHub rejected this token. Verify the saved GitHub token.'
            : error.status === 403
              ? 'GitHub denied this run. The token needs Actions: read permission and access to this repository.'
              : 'Run not found or this token cannot access the run. Confirm the repository and Actions: read permission.';
          return sendJson(res, error.status, { code: 'RUN_ACCESS_FAILED', message });
        }
      }
      if (run && ['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(String(run.status))) {
        return sendJson(res, 409, {
          code: 'RUN_LOGS_NOT_READY',
          message: 'GitHub does not provide the workflow log archive through this API while the run is still active. To show live CPU/RAM/RDP details, add the Live Runner Telemetry step from README-RUNNER-LIVE-TELEMETRY.md to the target repository workflow. Keep Actions: read permission enabled.'
        });
      }
      if (archiveError && ![404, 409].includes(archiveError.status)) {
        return sendJson(res, archiveError.status || 502, { code: 'RUN_LOG_FAILED', message: publicErrorMessage(archiveError) });
      }
      return sendJson(res, 404, { code: 'RUN_LOGS_UNAVAILABLE', message: 'No workflow log archive or job logs are available. Check Actions: read permission and GitHub log retention.' });
    }

    const parsed = parseRunnerLog(logResult.text);
    return sendJson(res, 200, { details: parsed.details, recentLines: parsed.recentLines, source: logResult.source });
  } catch (error) {
    return sendJson(res, error.status || 400, { code: 'RUN_LOG_FAILED', message: publicErrorMessage(error) });
  }
};
