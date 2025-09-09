# Inqwise MCP Site2TS – Chat Context Summary

Purpose: quick reference for Codex/terminal sessions.

## MVP Architecture Decisions
- Rust MCP server; Node helper (Playwright + Next.js). ARM-first (macOS/Linux).
- Filesystem-only cache and sandbox under `.site2ts/`.
- Persistent staging dir; apply overwrites target (use git for rollback).
- Manual audit (build-only: tsc + eslint).
- Full Tailwind conversion; full-page diffs; default tight tolerance.
- Latest stable Next.js/TS pinned per-project at init; Node 20 LTS prereq.
- No auth; no API client SDK in MVP.
- Strict prerequisites; per-project version pinning; manual updates unless corrupted.

## Backlog (return later)
- Hybrid Tailwind conversion strategy and auto-audit option.
- Auth via cookie/session injection.
- SDK generation from HAR.
- Artifact retention policy tuning; centralized cache option.
- Node 22 LTS validation; privileged installer for Linux deps.
