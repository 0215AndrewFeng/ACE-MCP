# v4.7.0 better-sqlite3 Blocking Fix

Author: feng.ling

## Goal

Reduce event-loop blocking caused by synchronous `better-sqlite3` reads on large search result paths while preserving existing MCP/Web behavior.

## Plan

- [x] Create task tracking files and confirm no prior lessons exist.
- [x] Locate the highest-impact synchronous SQLite search path.
- [x] Write a failing responsiveness regression test before production changes.
- [x] Implement the smallest non-blocking or paged execution boundary that makes the test pass.
- [x] Run focused test, full `npm test`, and `npm run build`.
- [x] Update release notes and roadmap for v4.7.0.
- [x] Record lessons after the fix.

## Validation Plan

- Focused RED/GREEN test for event-loop responsiveness while heavy DB work is running.
- Full unit/regression test suite: `npm test`.
- TypeScript build: `npm run build`.

## Comments

- 2026-06-24: Started v4.7.0 scope. `tasks/` did not exist, so no prior project lessons were available to review.
- 2026-06-24: RED test added in `src/core/search/searchServiceConcurrency.test.ts`; it fails because `SearchService.search` resolves before a 0ms timer can run.
- 2026-06-24: Implemented SQLite search worker for FTS/symbol/path/file-preview reads. Source/dev/test uses `node --import tsx` IPC child process; dist uses `worker_thread`.
- 2026-06-24: Verification passed: focused source concurrency test, focused dist concurrency test, `npm test` (59 tests), `npm run build`, `node dist/index.js --version` returning `4.7.0`, and full `npm run release:check` including pack/win/smoke.

# v4.7.1 Benchmark Tooling

Author: feng.ling

## Goal

Add repeatable benchmark tooling that quantifies search latency and event-loop responsiveness for indexed projects, so SQLite worker improvements can be measured with real data.

## Plan

- [x] Inspect existing release/test script patterns.
- [x] Write failing tests for benchmark package contract and SQLite worker connection pragmas.
- [x] Implement `scripts/benchmark-search.mjs` and `npm run benchmark:search`.
- [x] Stabilize benchmark smoke isolation and surface child-process logs on failures.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, and release checklist to v4.7.1.
- [x] Run focused tests, `npm test`, `npm run build`, benchmark smoke, and `npm run release:check`.
- [ ] Commit, tag, push, and replace the local 8787 process.

## Validation Plan

- Focused package manifest test for the new benchmark script.
- Benchmark smoke against the current large local index with JSON output.
- Full `npm test`.
- TypeScript build.
- Full `npm run release:check`.

## Comments

- 2026-06-24: Started v4.7.1 after v4.7.0 release. Worktree clean except existing untracked `.codex/`.
- 2026-06-24: During benchmark smoke, the existing 4.7.0 local service exposed SQLite lock failures and health timeouts. Expanded v4.7.1 scope to include worker connection busy-timeout/WAL pragmas plus smoke isolation diagnostics.
- 2026-06-24: Fixed benchmark smoke by isolating HOME, surfacing child logs, disabling auto-watch during the one-shot smoke server, and requiring a non-empty search result. Full `npm run release:check` passed with benchmark resultCount 1, search p95 78ms, health p95 12ms, and event-loop responsive 1/1.
- 2026-06-24: Version/docs updated to v4.7.1. Verification passed: focused package manifest + SQLite store tests, `npm test` (60 tests), `npm run build`, `npm run release:benchmark`, full `npm run release:check`, and `node dist/index.js --version` returned `4.7.1`.
