# Warp Guide – Architecture & Stack Overview

## High-Level Architecture
- **Rust MCP Server (`rust/site2ts-server`)** – Exposes the Site2TS JSON-RPC API, orchestrates jobs, persists artifacts under `.site2ts/`, and proxies work to the Node worker.
- **Node Worker (`node/site2ts-worker`)** – Handles crawl/analyze/generate/diff/apply logic. Crawling relies on Playwright; generation produces a Next.js staging app.
- **Staging Output (`.site2ts/staging/`)** – Next.js + Tailwind project built per run. Visual diffs use this staging app vs. captured baselines. Reports and exports live under `.site2ts/reports/` and `.site2ts/exports/`.

## Data Flow
1. **init** pins toolchain versions and prepares `.site2ts/`.
2. **crawl** uses Playwright to capture HTML, HAR, screenshots, and metadata per page hash.
3. **analyze** maps routes/assets from cached pages.
4. **scaffold** seeds a minimal Next.js project.
5. **generate** converts cached HTML to TSX, downloads assets, inlines critical CSS, and normalizes links.
6. **diff/audit/apply** operate on the staging app to validate, compare, and optionally write back to the repo.

## Code Stack & Guidelines
- **Rust** (server) for orchestration, file IO, and JSON-RPC plumbing. Follow rustfmt defaults; keep async runtime consistent (Tokio).
- **Node/TypeScript** (worker) compiled with `tsc`. Use ES modules, avoid CommonJS. Prefer functional helpers; keep side effects local to command handlers.
- **Playwright** for crawling/visual diff. Reuse helper utilities in `src/crawl.ts` and `src/diff.ts`; guard network access when running offline.
- **Next.js/Tailwind** for generated apps. Generator preserves original markup where possible, rewrites same-origin links relative, and inlines background assets (e.g., `wow-image`).
- **Testing/Validation** – Run `npm run build` (worker & staging) and `cargo build` before commits. Visual diffs require Chromium from Playwright; ensure the browser is installed.
- **Artifacts** – Never commit `.site2ts/`. Use `git clean -fdx .site2ts` after validation if space is needed.
