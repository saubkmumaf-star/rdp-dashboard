# Fix Vercel API route 404

Your GitHub repository must preserve these folders. Do not upload the files inside `api/` and `lib/` as loose root-level files.

Required paths:

- `api/config.js`
- `api/health.js`
- `api/running-runs.js`
- `api/run-log.js`
- `api/tailscale.js`
- `lib/api-helpers.js`
- `lib/runner-log-parser.js`
- `index.html`
- `package.json`
- `vercel.json`

## If using the GitHub website

For each misplaced root-level file, open it, click Edit (pencil), and change the filename/path field at the top to its full path, e.g. change `config.js` to `api/config.js`, then commit. Repeat for the path mapping above. For shared helpers, use `lib/api-helpers.js` and `lib/runner-log-parser.js`.

Alternatively, download this ZIP, extract it on a computer, and upload the complete extracted project while preserving the `api/` and `lib/` directories. Do not select individual files from those directories and upload them all to the repository root.

## Vercel

Set Root Directory to the project directory containing `index.html`, `api/`, `lib/`, `package.json`, and `vercel.json` together. Commit the changes and create a new Production deployment from that commit.

After deployment, open `/api/health`. A working route returns JSON. If it still returns Vercel's HTML 404, the production deployment is still not using the directory structure shown above. If it returns JSON with a Turso configuration/database error, then the route exists and we can diagnose the database separately.

Environment variables must be set for Production and the redeploy must use the latest commit. Never put Turso or GitHub tokens into source files.
