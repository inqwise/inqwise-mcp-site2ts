# Site2TS Runbook (MVP)

Quick guide to convert a site to Next.js + TypeScript using the MCP server + Node worker.

## Prereqs
- Node 20 LTS, npm
- Playwright (Chromium will be installed on first run if missing)
- Git (recommended)

## Workflow
1. init
   - Call `init` with `{ projectRoot: "." }`.
   - Creates `.site2ts/` sandbox and writes `pins.json`.
2. crawl
   - `crawl` with `{ startUrl, sameOrigin, maxPages, maxDepth, allow, deny, useSitemap, obeyRobots }`.
   - Saves artifacts to `.site2ts/cache/crawl/<sha1(url)>/` and sitemap manifest at `.site2ts/cache/sitemaps/<siteMapId>.json`.
3. analyze
   - `analyze` with `{ siteMapId }`.
   - Writes `.site2ts/staging/meta/analysis.json` and returns routes/assets summary.
4. scaffold
   - `scaffold` with `{ analysisId, appRouter: true }`.
   - Creates a minimal Next.js + Tailwind app in `.site2ts/staging/`.
5. generate
   - `generate` with `{ analysisId, scaffoldId, tailwindMode: "full" }`.
   - Converts crawled HTML to `app/<route>/page.tsx`, copies images to `app/(site2ts)/assets/`, removes scripts, maps common inline styles to Tailwind, and writes fallback report at `.site2ts/reports/tailwind/fallbacks.json`.
6. diff
   - `diff` with `{ generationId, baselines: "recrawl"|"cached", viewport, threshold }`.
   - Attempts to start the staging app and screenshot each route; writes baseline/actual/diff images and metrics under `.site2ts/reports/diff/<diffId>/`.
7. audit
   - `audit` with `{ generationId, tsStrict: true, eslintConfig: "recommended" }`.
   - Ensures deps, runs `tsc --noEmit` and `eslint . --format json`; writes reports under `.site2ts/reports/tsc/` and `.site2ts/reports/eslint/`.
8. apply
   - `apply` with `{ generationId, target: "./", dryRun: false }`.
   - Copies files from staging to target; computes safe deletions under `target/app/` for assets and page files not present in staging; dry-run writes a plan.
9. assets / pack
   - `assets` returns a path to a simple manifest of generated assets.
   - `pack` creates `.site2ts/exports/site2ts-mvp.tgz` with staging and reports.

## Artifacts
- Sandbox: `.site2ts/`
- Crawl cache: `.site2ts/cache/crawl/<sha1>/`
- Sitemaps: `.site2ts/cache/sitemaps/<siteMapId>.json`
- Staging app: `.site2ts/staging/`
- Reports: `.site2ts/reports/`
- Exports: `.site2ts/exports/`

## Notes
- Tailwind mapping is conservative; remaining inline styles are tracked in the fallback report for follow-up.
- Visual diffs will fall back to baseline-as-actual if the app fails to start.
- Apply respects exclusions: `.git/`, `.env*`, `.site2ts/`, `node_modules/`.

