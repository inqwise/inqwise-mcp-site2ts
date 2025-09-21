# Project Progress

This file tracks high-level tasks and status. One active task at a time.

## Status Legend
- [ ] Pending
- [>] In Progress
- [x] Completed

## Tasks
- [ ] Define MCP API JSON schemas
- [ ] Scaffold Rust MCP server
- [ ] Scaffold Node worker
- [ ] Implement crawl and cache
- [ ] Implement analyze outputs
- [ ] Implement scaffold (Next+Tailwind)
- [ ] Implement generate (HTML→TSX)
- [ ] Implement visual diff
- [ ] Implement audit (tsc/eslint)
- [ ] Implement apply (safety)
- [ ] Implement assets and pack
- [ ] Integrate logging and errors
- [ ] Add version pinning init
- [ ] Docs and examples
- [>] Repo scaffolding and progress tracking

## Notes
- Commits are created only at important milestones or upon task completion.
- NDJSON logs and IDs (ULIDs) must align with the spec.
- 2025-09-19: Generator now keeps original markup, rewrites same-origin links to relative paths, and inlines Wix background assets (wow-image) for higher visual fidelity.
- 2025-09-21: Diff pipeline now emits per-route heatmaps with DOM zone mappings and MCP `improve` method records automated remediation instructions for downstream tooling.
- 2025-09-21: Added `tools/plan-improvements.js` to parse diff summaries, filter already-attempted issues, and surface orchestrator-ready action plans/stop signals.
