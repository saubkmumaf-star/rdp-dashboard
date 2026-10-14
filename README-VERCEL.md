# Actions + Tailscale Dashboard — Vercel with automatic Turso sync

A multi-repository GitHub Actions dashboard with automatic Turso state loading, cross-browser configuration sync, parallel workflow dispatch, Tailscale machine approval, and active runner cards.

## Required security setup — no dashboard key prompt

This version removes the separate `DASHBOARD_ACCESS_KEY` input and uses Vercel's deployment-level authentication instead. **The entire deployment and every `/api/*` route must be protected** because the shared database state contains GitHub/Tailscale credentials and runner APIs can return sensitive RDP session information.

In Vercel, open **Project → Security (or Settings) → Deployment Protection**, select **All Deployments**, and enable **Vercel Authentication**. Add the browser/device user's Vercel account to the project's authorized viewers. This means no per-page dashboard key is needed; a new browser signs into Vercel and the app loads its state automatically. Do not disable this protection or make the deployment public.

## Deploy and configure

1. Extract the **flat-root ZIP**. Put its contents directly at the root of a **private GitHub repository**: `index.html`, `package.json`, `vercel.json`, `api/`, and `lib/` must be siblings. Import that repository into Vercel.
2. Enable **Deployment Protection → All Deployments → Vercel Authentication** before using the site.
3. In **Vercel → Project → Settings → Environment Variables**, add only the server-side database variables below for Production (and Preview only if those deployments are intentionally protected and used):
   - `TURSO_DATABASE_URL`: your database URL, e.g. `https://<database>.<region>.turso.io` or the `libsql://...turso.io` URL shown in Turso.
   - `TURSO_AUTH_TOKEN`: a newly generated Turso database auth token with read/write permission (saving shared configuration needs write access).
4. Redeploy after setting the environment variables.
5. Open the protected deployment. The page automatically calls `/api/config`, reads `cfg(k='gha-dashboard')`, and populates the dashboard. There is no Dashboard Access Key input and no separate Running Runners key.
6. The dashboard keeps using the JSON object format in the existing `cfg.v` value, including `tokens`, `repos`, `activeRepo`, `settings`, and `tailscale`. When a key or configuration is saved in the dashboard, it automatically writes the new JSON to the same `cfg` row. Other open devices usually receive updates/deletions within about five seconds.
7. To show runner details before GitHub publishes downloadable workflow logs, follow `README-RUNNER-LIVE-TELEMETRY.md`. Set `RUNNER_INGEST_TOKEN` in Vercel and as a secret in the target workflow repository, then add the telemetry step and dispatch a new run.
7. If `cfg` has no `gha-dashboard` row but the previous release's `dashboard_shared_config` table does, the API imports that row into `cfg`. The old row is not deleted.

## GitHub and Tailscale permissions

- Add GitHub tokens in **Tokens & Repos**. Use a fine-grained token restricted to the required repository. Actions read is enough to list runs; Actions write is needed for dispatch, cancel, and re-run operations.
- Add the Tailscale API token under **Tailscale Machines**. Reading devices needs `devices:core:read`; approval requires the appropriate write permissions and any required tagged-device permissions.
- All GitHub/Tailscale token changes made in the dashboard are stored in the shared Turso JSON row so an authorized browser can use the same configuration. Rotate any token previously pasted into chat, screenshots, source code, or logs.

## Auto-refresh and shared state

- The app loads Turso state on every fresh page visit; browser `localStorage` is only a cache/fallback and is not required to populate a new browser.
- Shared config is polled every five seconds while the page is visible. UI key/config edits and deletions schedule a write to Turso; revision checks and merge handling reduce the chance of a stale browser overwriting another browser's changes.
- Manual edits to the JSON `v` cell in Turso are detected by comparing the current JSON as well as the revision. Use valid JSON and preserve the same top-level state structure.
- Workflow runs and Tailscale devices poll using the dashboard interval (5–300 seconds, default 15 seconds). Runner log archives refresh at most every 30 seconds automatically, or manually through Refresh Now.
- This is polling, not push/WebSocket realtime; updates generally appear after the next poll.

## Environment variables

These two variables are required for shared Turso sync. `RUNNER_INGEST_TOKEN` is additionally required only if you want live runner telemetry before GitHub exposes the workflow log archive:

```dotenv
TURSO_DATABASE_URL=https://your-database-your-region.turso.io
TURSO_AUTH_TOKEN=replace-with-a-new-turso-auth-token
RUNNER_INGEST_TOKEN=replace-with-a-long-random-ingest-secret
```

Do not put a Turso token in `index.html`, browser storage, or a public repository. GitHub and Tailscale credentials are stored in the protected `cfg.v` JSON state, not in Vercel environment variables.

## Important security note

Because this app intentionally auto-loads the full shared configuration, `/api/config` returns credentials to the authenticated browser. The custom access-key prompt was removed as requested, so **Vercel Authentication / All Deployments protection is the access-control layer**. If it is disabled, anyone able to reach the deployment may be able to retrieve configured GitHub/Tailscale tokens and running-runner details. Do not deploy this app publicly.

## Project files

- `index.html` — dashboard UI, auto cloud load, cross-browser sync, multi-repository runs, approval actions, and runner cards.
- `api/config.js` — Turso `cfg` JSON load/save, in-place schema upgrade, revision conflict checks, and compatibility import from the previous shared table.
- `api/tailscale.js` — same-origin Tailscale API proxy with an allowlist of device endpoints.
- `api/running-runs.js` — active GitHub Actions workflow-run lookup.
- `api/run-log.js` — run-archive and individual-job log retrieval, runner detail extraction, and password-redacted preview.
- `api/runner-live.js` — securely ingests live runner telemetry from the target GitHub Actions workflow and serves it only after the request's GitHub token is verified against that repository/run.
- `lib/api-helpers.js` — validation, GitHub API handling, and safe responses.
- `lib/runner-log-parser.js` — runner detail parser.
- `test/` — API, sync, and log parser smoke tests.
- `.env.example` — local environment template.

## Fixing `/api/config` HTTP 404

An HTTP 404 from `/api/config` means Vercel did not deploy the API function; it does **not** mean the Turso environment variables were rejected. Environment variables alone cannot create an API route.

- The Git repository root must contain `index.html`, `package.json`, `vercel.json`, `api/config.js`, `api/health.js`, and `lib/api-helpers.js`.
- Vercel → Project → Settings → Build & Development Settings → **Root Directory** must point at the directory containing both `index.html` and `api/`. For this flat ZIP, use the repository root.
- Deploy the entire project, not just `index.html`. Push all files and redeploy to Production.
- Open `https://YOUR-DOMAIN/api/health`. It should return JSON containing `"ok":true`. If this URL also gives 404, the deployment still uses the wrong root or old commit. Once health works, open `/api/config`; it should return JSON from Turso.
- A `401`/`403` from the site itself may be Vercel Deployment Protection, which must be enabled for the whole app and APIs. Sign in to Vercel from the browser first.

## Troubleshooting

- **`/api/config` HTTP 404:** use the flat-root ZIP, confirm `api/config.js` is at the chosen Vercel Root Directory, test `/api/health`, and redeploy the complete project.
- **Turso HTTP 503:** verify both `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set in the correct Vercel environment and redeploy.
- **Turso HTTP 401/403:** the database token may be expired/revoked or have insufficient access. Generate a replacement and update the Vercel environment variable.
- **Data loads in one browser but not another:** verify that both browsers open the same deployment and can pass Vercel Authentication, and that `cfg` has a row with `k='gha-dashboard'`.
- **Writes appear to work but old table stays unchanged:** this version writes the canonical JSON into `cfg.v`; `dashboard_shared_config` is only a compatibility mirror for an older release.
- **GitHub 403:** check repository access, API limits, and Actions permissions.
- **Tailscale approval 403:** the token likely lacks device write/approval permissions.
- **Runner details not found while a run is active:** GitHub may return 404 for run/job log downloads until logs become downloadable. Add the live telemetry step in `README-RUNNER-LIVE-TELEMETRY.md`, set `RUNNER_INGEST_TOKEN` in Vercel and as a Secret in the target GitHub repository, then start a new run. Archived/job logs remain a fallback after they become available.

## Tests

Run `npm test` with Node.js 20 or later. Automated tests cover keyless API access under the expected deployment-level protection, loading/storing `cfg` JSON, legacy shared-table migration, revision conflicts, runner log redaction, and Tailscale approval request validation. Tests do not replace live validation with your Vercel/Turso/GitHub/Tailscale environment.
