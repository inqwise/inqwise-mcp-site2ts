# Inqwise MCP Site2TS

Convert existing websites into TypeScript-based Next.js apps via an MCP server (Rust) and a Node helper (Playwright + Next.js). ARM-first (macOS/Linux). See `SITE2TS_MISSION_SPEC.md` for the authoritative MVP contract.

## Quick Start
- Read the mission spec: `SITE2TS_MISSION_SPEC.md`.
- Track progress: `PROGRESS.md` (human) and `progress.json` (machine-readable).
- Commit policy: only at important milestones or task completion.

## Repo Layout
- `.site2ts/` (runtime sandbox; generated during runs)
- `SITE2TS_MISSION_SPEC.md` (MVP rules and API)
- `PROGRESS.md` and `progress.json` (tasks + statuses)

## Project Management Rules
- Tasks are defined in `PROGRESS.md` and mirrored in `progress.json`.
- We update progress as tasks complete; only one active in-progress task at a time.
- Commits are reserved for important milestones or completion of a task.

## Remote Repository
Planned GitHub remote: `git@github.com:inqwise/inqwise-mcp-site2ts.git` (confirm or provide a different name).

Setup (once the remote exists):

```
# Initialize and set remote
git init
git remote add origin git@github.com:inqwise/inqwise-mcp-site2ts.git

# First milestone commit will be pushed like:
# git push -u origin main
```

If creating the repo via GitHub UI, choose: Owner `inqwise`, repo name `inqwise-mcp-site2ts`, default branch `main`.

## Prerequisites (runtime)
- Node 20 LTS, npm
- Playwright (Chromium installed on first init)
- Git (recommended)

## Status
MVP spec authored; implementation tasks planned. See `PROGRESS.md`.

## License
Apache-2.0 — see `LICENSE` for details.

## Runbook
See `docs/RUNBOOK.md` for the end-to-end flow and artifact locations.

More examples: `docs/API_EXAMPLES.md`.

## Build and Run Locally
- Build worker (TS) and server (Rust), then send one JSON-RPC request:
  - `tools/rpc.sh '{"jsonrpc":"2.0","method":"init","params":{"projectRoot":"."},"id":1}'`
- Send subsequent requests by calling `tools/rpc.sh` again with a single-line JSON object (each run builds if needed and executes one request).

Notes:
- The Rust server spawns the Node worker from `node/site2ts-worker/dist/index.js`, so the worker must be built first (`npm run build`). The script does this for convenience.
- For interactive sessions (multiple requests in one process), you can run the server directly and feed it one JSON line per request via stdin.

## Dependencies Policy
- Rust crates: pinned to latest minor/patch series for stability (see `rust/site2ts-server/Cargo.toml`). We periodically bump to latest stable; breaking bumps are handled explicitly.
- Node (worker):
  - TypeScript toolchain uses caret ranges to pick up minor/patch updates automatically:
    - `typescript` (>=5.5), `@typescript-eslint/*` (v8), `eslint` (v9), `prettier` (v3), `eslint-plugin-import`, `eslint-config-prettier`.
  - Runtime deps (`playwright`, `playwright-core`, `pixelmatch`, `pngjs`, `get-port`, etc.) also use caret ranges for minor/patch updates.
- Generated staging app:
  - `next` pinned to a secure version (currently 14.2.32) to avoid known CVEs.
  - Dev toolchain uses caret ranges for minor/patch updates (TypeScript, Tailwind, PostCSS stack).

## Roadmap / Next Improvements
- Tailwind mapping: expand utilities (colors, shadows, line-height/letter-spacing mapping), reduce CSS fallback footprint.
- Visual diff: harden Next.js start/screenshot timing; support multiple viewports (mobile).
- Apply: deeper route-aware deletions; additional safety prompts in plan mode.
- Tests: unit tests for HTML→TSX and `mapInlineStyleToTw` to avoid regressions.
- Packaging: optional CLI wrapper for JSON-RPC; simple config file support.
- Platform: Windows support (non-goal for MVP) to be evaluated later.

We will open GitHub Issues to track these items; for now this section serves as the authoritative TODO list.

## Troubleshooting
- Playwright/Chromium missing: run `npx playwright install chromium` (the server also attempts this during `init`). Ensure Node 20 LTS is active.
- Next.js build errors in staging: run `npm install` (or `npm ci` if a lockfile exists) in `.site2ts/staging/` before `audit`/`diff`.
- Port conflicts when starting staging app for diffs: the worker auto-picks a free port; if it still fails, re-run `diff` or kill stray `node`/`next` processes.
- Timeouts on slow sites: lower `maxPages`/`maxDepth` or increase thresholds; re-run `crawl` with `delayMs` > 0 to be polite.
- Clean slate: remove `.site2ts/` to reset caches and staging.

## JSON-RPC Examples (MVP)

- `init`
  - Request: `{ "method": "init", "params": { "projectRoot": "." }, "id": 1 }`
  - Result: `{ "ok": true, "pinned": { "node": "20.x", "next": "14.x", "ts": "5.x", "playwright": "1.x" } }`

- `crawl`
  - Request: `{ "method": "crawl", "params": { "startUrl": "https://example.com", "sameOrigin": true, "maxPages": 25, "maxDepth": 3 }, "id": 2 }`
  - Result: `{ "jobId": "01...", "siteMapId": "01...", "pages": [{"url":"...","hash":"..."}] }`

- `analyze`
  - Request: `{ "method": "analyze", "params": { "siteMapId": "01..." }, "id": 3 }`
  - Result: `{ "jobId": "01...", "analysisId": "01...", "routes": [...], "assets": {...} }`

- `scaffold`
  - Request: `{ "method": "scaffold", "params": { "analysisId": "01...", "appRouter": true }, "id": 4 }`
  - Result: `{ "jobId": "01...", "scaffoldId": "01...", "outDir": ".site2ts/staging" }`

- `generate`
  - Request: `{ "method": "generate", "params": { "analysisId": "01...", "scaffoldId": "01...", "tailwindMode": "full" }, "id": 5 }`
  - Result: `{ "jobId": "01...", "generationId": "01..." }`

- `diff`
  - Request: `{ "method": "diff", "params": { "generationId": "01...", "baselines": "recrawl", "viewport": {"w":1280,"h":800,"deviceScale":1}, "threshold": 0.01 }, "id": 6 }`
  - Result: `{ "jobId": "01...", "diffId": "01...", "perRoute": [...], "summary": {"passed":1,"failed":0,"avg":0.004} }`

- `audit`
  - Request: `{ "method": "audit", "params": { "generationId": "01...", "tsStrict": true, "eslintConfig": "recommended" }, "id": 7 }`
  - Result: `{ "jobId": "01...", "auditId": "01...", "tsc": {"errors":0, "reportPath":"..."}, "eslint": {"errors":0, "warnings":2, "reportPath":"..."} }`

- `apply`
  - Request: `{ "method": "apply", "params": { "generationId": "01...", "target": "./", "dryRun": false }, "id": 8 }`
  - Result: `{ "jobId": "01...", "applied": true, "changedFiles": ["app/..."], "deletedFiles": {"removed":[...], "skipped":[...]} }`

- `assets`
  - Request: `{ "method": "assets", "params": { "generationId": "01..." }, "id": 9 }`
  - Result: `{ "jobId": "01...", "manifestPath": ".site2ts/reports/assets-manifest.json" }`

- `pack`
  - Request: `{ "method": "pack", "params": { "generationId": "01..." }, "id": 10 }`
  - Result: `{ "jobId": "01...", "tarPath": ".site2ts/exports/site2ts-mvp.tgz" }`
