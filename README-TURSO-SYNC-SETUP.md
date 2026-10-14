# Automatic Turso sync setup

1. Revoke/rotate any GitHub or Tailscale token that was pasted into chat or screenshots. Do not reuse those exposed values.
2. Set `TURSO_DATABASE_URL` and a newly generated read/write `TURSO_AUTH_TOKEN` in Vercel Environment Variables, then redeploy.
3. Enable Vercel → Security/Settings → Deployment Protection → **All Deployments** → **Vercel Authentication** and authorize the accounts that should use the dashboard. This replaces the dashboard's manual access-key form.
4. Open the protected site on PC/mobile. The page automatically GETs `/api/config`; the API reads the existing Turso `cfg` row where `k='gha-dashboard'` and loads its JSON value.
5. Any GitHub/Tailscale token, repository, branch, workflow, label, or setting saved in the UI is written back to the same `cfg.v` JSON row. Other open browsers poll and pick up changes or deletions about every five seconds.
6. If `cfg` has no row but the previous version's `dashboard_shared_config` row exists, it is copied into `cfg`. The old row is retained.

Expected `cfg.v` JSON structure remains:

```json
{
  "tokens": {},
  "repos": [],
  "activeRepo": null,
  "settings": { "interval": 15 },
  "tailscale": { "token": "", "tailnet": "-" }
}
```

The object above is only a shape example. Keep actual GitHub and Tailscale secrets private. `TURSO_AUTH_TOKEN` stays on the server and is not part of this JSON. Do not disable Vercel Deployment Protection; otherwise the API can expose the shared credentials and runner information.


## Troubleshooting HTTP 404

`Shared database request failed (HTTP 404)` means `/api/config` was not deployed at the selected Vercel Root Directory. This is different from invalid Turso credentials. The repository root must contain `index.html`, `package.json`, `vercel.json`, `api/config.js`, and `lib/api-helpers.js`. Deploy the complete project, not just the HTML. Test `/api/health` and confirm it returns `{"ok":true,...}` before diagnosing Turso settings.


## If the page says HTTP 404

This response means the Vercel API route is missing from the deployed project, usually because only `index.html` was uploaded or Vercel's Root Directory points at the wrong folder. The flat ZIP has all project files directly at its root. Deploy the complete contents together. Test `/api/health`; if it is 404 too, adjust Vercel's Root Directory to the folder containing `index.html` and `api/`, then redeploy Production. Do not keep changing Turso credentials to solve a missing route.
