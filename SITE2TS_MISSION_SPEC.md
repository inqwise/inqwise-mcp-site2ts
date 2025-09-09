# Inqwise MCP Site2TS – Mission Spec (MVP)

This document captures the authoritative MVP rules, API surface, and operational expectations for the Site2TS MCP server and its Node helper. It consolidates the architecture draft and chat context, plus working conventions for this repo.

## Mission Overview
- Convert existing websites into TypeScript-based Next.js apps using a Rust MCP server orchestrating a Node helper (Playwright + Next.js). ARM-first.
- Enforce a sandboxed working area under `.site2ts/` with staging, cache, reports, and logs.
- MVP flow: init → crawl → analyze → scaffold → generate → diff → audit → apply. Visual diffs and Tailwind-first generation included.

## Filesystem Layout
project-root/
  .site2ts/
    staging/      – generated/scaffolded output pending apply
    cache/        – crawl artifacts, browser cache
      pw/         – Playwright browser cache
      crawl/<sha1(url)>/{page.html, meta.json, snap.png, snap.mobile.png, page.har}
      sitemaps/<siteMapId>.json
    reports/
      diff/<diffId>/<route>/{baseline.png, actual.png, diff.png, metrics.json}
      tsc/<auditId>.json
      eslint/<auditId>.json
      apply/<jobId>.plan.json
      tailwind/fallbacks.json
    logs/<jobId>.ndjson
    pins.json
    exports/site2ts-mvp.tgz

## MCP API Surface (MVP)
All tools are sync JSON-in/JSON-out over stdio.

- init → { projectRoot } → { ok, pinned: { node:"20.x", next:"14.x", ts:"5.x", playwright:"1.x" } }
- crawl → { startUrl, sameOrigin:true, maxPages:50, maxDepth:5, allow:[], deny:[], concurrency:4, delayMs:0, useSitemap:true, obeyRobots:true } → { jobId, siteMapId, pages:[{url,hash}] }
- analyze → { siteMapId } → { jobId, analysisId, routes:{...}, assets:{...} }
- scaffold → { analysisId, appRouter:true } → { jobId, scaffoldId, outDir:".site2ts/staging" }
- generate → { analysisId, scaffoldId, tailwindMode:"full" } → { jobId, generationId }
- diff → { generationId, baselines:"recrawl"|"cached", viewport:{w:1280,h:800,deviceScale:1}, threshold:0.01 } → { jobId, diffId, perRoute:[{route, diffRatio, artifacts:{baseline,actual,diff}}], summary:{passed,failed,avg} }
- audit → { generationId, tsStrict:true, eslintConfig:"recommended" } → { jobId, auditId, tsc:{errors,reportPath}, eslint:{errors,warnings,reportPath} }
- apply → { generationId, target:"./", dryRun:false } → { jobId, applied:true, changedFiles, deletedFiles }
- assets → { siteMapId | generationId } → { jobId, manifestPath }
- pack → { generationId } → { jobId, tarPath:".site2ts/exports/site2ts-mvp.tgz" }

IDs are ULIDs. Each tool returns a `jobId` and its entity id.

## Error Model
On error: { ok:false, error:{ code, message, data }, partial?:{...} }

Codes: BAD_INPUT, ENV_MISSING, CRAWL_TIMEOUT, ROBOT_BLOCKED, ANALYZE_UNSUPPORTED, CODEGEN_FAILED, AUDIT_FAILED, APPLY_BLOCKED.

## Logging (NDJSON)
File: `.site2ts/logs/<jobId>.ndjson`
Entry: { ts, level(debug|info|warn|error), jobId, phase(init|crawl|analyze|scaffold|generate|diff|audit|apply|pack), msg, data }

Example: { "ts":"2025-09-09T11:21:03.123Z","level":"info","jobId":"01J..","phase":"crawl","msg":"Fetched","data":{"url":"…","status":200,"ms":412}}

## Crawl
- Scope: same-origin enforced. `allow`/`deny` support globs and regex (globs: prefix).
- Limits: `maxPages` default 50 (1–2000 supported), `maxDepth` default 5.
- Rate: `concurrency` default 4, `delayMs` default 0.
- Robots/Sitemaps: obey robots.txt by default; attempt sitemap.xml discovery.
- Artifacts: `.site2ts/cache/crawl/<sha1(url)>/` → `page.html`, `meta.json` (title, meta, headers), `snap.png`, `snap.mobile.png`, `page.har`.
- Site map manifest: `.site2ts/cache/sitemaps/<siteMapId>.json`.

## Analyze Output
Path: `.site2ts/staging/meta/analysis.json`

{
  "routes": [
    {"route":"/","sourceUrl":"…","dynamic":false},
    {"route":"/products/[slug]","sourceUrl":"…","params":["slug"],"dynamic":true}
  ],
  "forms": [
    {"route":"/contact","method":"POST","fields":["name","email","message"]}
  ],
  "assets": {"images":[], "fonts":[], "styles":[]}
}

- Route inference prefers Next.js App Router; dynamic segments via URL patterns.
- Forms captured for future wiring; no live backend in MVP.

## Scaffold / Generate Rules
- Next.js: App Router, TS enabled, `strict: true`.
- Tailwind: initialized in project. MVP target is near full Tailwind conversion.
- Fallbacks: when utilities cannot express layout succinctly, create a per-file CSS Module (`.module.css`) with a `// TODO: tailwindify` banner. Track all fallbacks in `.site2ts/reports/tailwind/fallbacks.json`.
- HTML→TSX: preserve semantic tags; `class`→`className`; map inline styles to utilities; strip event handlers; omit third‑party scripts with `// TODO: integrate script <src>` placeholder.
- Assets: images/fonts copied to `app/(site2ts)/assets/*` with hashed names; references updated.
- Fonts: prefer `next/font` when detectable; otherwise download and emit `@font-face`.

## Visual Diffs
- Tooling: Playwright pixel comparison.
- Viewports: desktop 1280×800, deviceScale 1 (MVP). Mobile later.
- Threshold: default `0.01` (≤1% changed pixels passes); configurable.
- Output: `.site2ts/reports/diff/<diffId>/<route>/{baseline.png, actual.png, diff.png, metrics.json}` with `metrics.json = { total, changed, ratio }`.
- Baselines: `recrawl` current site unless `baselines:"cached"` is selected.

## Audit
- TypeScript: `tsc --noEmit --pretty false --incremental false`; report `.site2ts/reports/tsc/<auditId>.json`.
- ESLint: base "recommended" + `@next/eslint-plugin-next` defaults; report `.site2ts/reports/eslint/<auditId>.json`.
- Pass/Fail: `AUDIT_FAILED` when `tsc.errors > 0`. ESLint failures warn but do not block apply in MVP.

## Apply Safety
- Exclusions: `.git/`, `.env*`, `.site2ts/`, `node_modules/`.
- Deletes: allowed only for files mapping to generated routes; others retained and listed under `deletedFiles.skipped`.
- Dry-run: write plan to `.site2ts/reports/apply/<jobId>.plan.json`.
- Symlinks resolved; writes outside project are blocked.

## Node Helper Interface
- Process model: long-lived Node worker spawned by Rust; JSON-RPC over stdio.
- Large payloads passed by file path; avoid large JSON blobs in messages.
- Playwright: `playwright install chromium` on init if missing; browser cache under `.site2ts/cache/pw/`.
- Worker writes artifacts per on-disk layout above.

## Version Pinning
File: `.site2ts/pins.json`

{
  "node": "20.15.0",
  "next": "14.2.5",
  "typescript": "5.5.4",
  "playwright": "1.46.0",
  "tailwind": "3.4.10",
  "createdAt": "2025-09-09T..."
}

- Upgrades: manual via `init --upgrade` writing `.site2ts/upgrades/<timestamp>.json` diff. Fail closed if runtime does not match pin.

## Platforms
- ARM-first (Apple Silicon, Graviton). Supported: macOS, Linux. Windows later (non-goal for MVP).
- Prereqs: Node 20 LTS, npm, Playwright. Git recommended for rollback.

## Assets / Pack
- `assets`: emit consolidated manifest for downloaded/copied files for audits/licensing.
- `pack`: produce tarball of staging output + reports: `.site2ts/exports/site2ts-mvp.tgz`.

## Operating Principles (Concise)
- Sandbox-only writes under `.site2ts/` until `apply` with explicit target.
- Deterministic IDs (ULIDs) for traceability across logs, artifacts, and reports.
- Favor small, composable tools; consistent JSON shapes; NDJSON logs with clear `phase`.
- Tailwind-first codegen with explicit, tracked fallbacks.
- Manual audits are authoritative; ESLint is advisory for MVP.

## Status
This spec reflects the agreed MVP rules and serves as the working contract for implementation. Update in lockstep with code changes.

## Project Management Rules
- Task tracking lives in `PROGRESS.md` (human-readable) and `progress.json` (machine-readable). Exactly one task should be in progress at any time.
- We manage progress using these files and an external plan tool; we will update statuses as milestones complete.
- Commit policy: commit only at important milestones or on completion of a task. Avoid granular commits that do not represent meaningful progress.
- Remote repository: host under `inqwise` on GitHub via SSH. Proposed name `inqwise-mcp-site2ts` unless otherwise specified.
