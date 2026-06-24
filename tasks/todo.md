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
