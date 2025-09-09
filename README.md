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
