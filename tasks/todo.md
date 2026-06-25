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
- [x] Commit, tag, push, and replace the local 8787 process.

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
- 2026-06-24: Committed `d769197`, tagged `v4.7.1`, pushed `master` and `v4.7.1` to Gitee, replaced the local 8787 process, and verified `/health` returns version `4.7.1`.

# v4.7.2 Health Responsiveness

Author: feng.ling

## Goal

Keep `/health` responsive while background indexing or SQLite writes are active, so the long-lived Web service remains observable even during heavy local project churn.

## Plan

- [x] Inspect current health/meta route dependencies and identify synchronous SQLite reads.
- [x] Write a failing regression test that simulates slow project stats and requires `/health` to return quickly.
- [x] Move `/health` to cached or in-memory runtime/index snapshots instead of blocking storage reads.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, and release checklist to v4.7.2.
- [x] Run focused tests, `npm test`, `npm run build`, `npm run release:check`, commit, tag, push, and replace the local 8787 process.

## Validation Plan

- Focused Web app regression test for `/health` responsiveness under slow stats reads.
- Full `npm test`.
- TypeScript build.
- Full `npm run release:check`.

## Comments

- 2026-06-24: Started v4.7.2 after v4.7.1 release. Trigger: local 8787 was running v4.7.1, but `/health` still timed out while background indexing was active.
- 2026-06-24: RED test added in `src/web/app.test.ts`; current `/health` waited for simulated slow `getProjectStats` and took 252ms.
- 2026-06-24: `/health` now avoids per-project `getProjectStats`, keeps lightweight runtime/project/in-flight fields, and focused test passes in about 8ms.
- 2026-06-24: Verification passed: focused Web/package tests, `npm test` (61 tests), `npm run build`, and full `npm run release:check`. Release benchmark smoke returned resultCount 1, search p95 43ms, health p95 6ms, event-loop responsive 1/1.

# v4.7.3 Index Queue Coalescing

Author: feng.ling

## Goal

Reduce duplicate background index work and make queue/coalescing state visible, so watch-triggered churn does not keep hammering SQLite with redundant same-project scans.

## Plan

- [x] Inspect current `IndexCoordinator` queue, in-flight reuse, and watch debounce behavior.
- [x] Write a failing regression test for same-project duplicate index requests and queue status visibility.
- [x] Implement coalesced queue status counters for running, queued, and deduped requests without changing public indexing results.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, and release checklist to v4.7.3.
- [x] Run focused tests, `npm test`, `npm run build`, `npm run release:check`, commit, tag, push, and replace the local 8787 process.

## Validation Plan

- Focused `IndexCoordinator` test for duplicate same-project requests.
- Focused Web health/runtime surface check if queue status shape changes.
- Full `npm test`.
- TypeScript build.
- Full `npm run release:check`.

## Comments

- 2026-06-24: Started v4.7.3 after v4.7.2 release. Current code reuses in-flight promises but `/health` only exposes elapsed in-flight indexes, not queued/deduped pressure, making repeated watch/index churn hard to diagnose.
- 2026-06-24: Added focused regression for duplicate same-project index requests. It exposed missing `dedupedRequests/status` visibility and an unhandled rejection risk in `indexPromise.finally()` cleanup.
- 2026-06-24: Implemented `dedupedRequests`, `queuedRequests`, and `status` in `getInFlightIndexInfo()`, added timeout timer cleanup, and verified focused IndexCoordinator/Web tests plus build.
- 2026-06-24: Verification passed: focused IndexCoordinator/Web/package tests, `npm test` (62 tests), `npm run build`, and full `npm run release:check`. Release benchmark smoke returned resultCount 1, search p95 42ms, health p95 7ms, event-loop responsive 1/1.

# v4.7.4 JS Cross-file Type Propagation

Author: feng.ling

## Goal

Resolve JS/TS method calls like `foo.method()` to imported class methods across files when `foo` is constructed from an imported type, while preserving existing query behavior for other languages.

## Plan

- [x] Review relevant lessons and current task state.
- [x] Locate JS/TS symbol extraction, usage extraction, and call/reference resolution paths.
- [x] Write a failing regression test for cross-file JS/TS `new ImportedClass().method()` resolution.
- [x] Add a non-JS/TS guard regression proving other languages keep their existing query behavior.
- [x] Implement the smallest JS/TS-only type propagation change.
- [x] Run focused tests, full `npm test`, `npm run build`, and full `npm run release:check`.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, release checklist, and lessons.
- [x] Commit, tag, push, and replace the local 8787 process if verification passes.

## Validation Plan

- Focused regression test for JS/TS cross-file constructor/import method call resolution.
- Focused regression or existing suite coverage showing non-JS/TS language queries are unchanged.
- Full unit/regression test suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.

## Comments

- 2026-06-24: Started v4.7.4 after v4.7.3 release. Constraint from user: do not affect existing query behavior for other languages.
- 2026-06-24: RED test confirmed `import { discountService }` where `discountService` is `export const discountService = new DiscountService()` did not resolve `discountService.applyDiscount()` to `DiscountService.applyDiscount`; Python variable-type call graph guard stayed green.
- 2026-06-24: Implemented JS-only exported value type propagation using an internal candidate prefix and JavaScript-only alias resolution priority. Focused workflow test, `npm test` (64 tests), and `npm run build` passed before release docs were updated.
- 2026-06-24: Final verification passed: focused workflow test, `npm test` (64 tests), `npm run build`, `node dist/index.js --version` returning `4.7.4`, and full `npm run release:check`. Release benchmark smoke returned resultCount 1, search p95 39ms, health p95 5ms, and event-loop responsive 1/1.
- 2026-06-25: Committed `0e266ac`, tagged `v4.7.4`, pushed `master` and `v4.7.4` to Gitee, stopped old local pid `7233`, and verified `http://127.0.0.1:8787/health` returns version `4.7.4` on pid `34034`.

# v4.7.5 Markdown Symbol Extraction

Author: feng.ling

## Goal

Extract Markdown headings as searchable section symbols and identifiers from fenced code blocks as symbol usage, improving documentation and RAG recall without perturbing existing code-language behavior.

## Plan

- [x] Review lessons and record the task plan before implementation.
- [x] Locate Markdown indexing, language detection, symbol extraction, and usage extraction paths.
- [x] Write failing regression tests for Markdown heading symbols and fenced code-block identifier usages.
- [x] Implement the smallest Markdown-only extraction change.
- [x] Run focused tests, `npm test`, `npm run build`, and release validation.
- [x] Update README, CHANGELOG, ROADMAP, version metadata, and lessons.

## Validation Plan

- Focused regression proving Markdown headings are indexed as section symbols.
- Focused regression proving fenced code identifiers are indexed as usage without creating false headings.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Release validation: `npm run release:check`.

## Comments

- 2026-06-25: Started v4.7.5 after user selected Markdown symbol extraction over SFC support. Relevant lessons reviewed: keep language-specific resolver changes scoped and guarded; verify full release path before handoff.
- 2026-06-25: RED confirmed: new Markdown adapter tests failed with empty symbols/usages, and workflow test failed because no Markdown section definition was indexed.
- 2026-06-25: GREEN confirmed: Markdown adapter now extracts heading `section` symbols and fenced code `usage` records; focused adapter and search workflow tests pass.
- 2026-06-25: Build initially caught that `LanguageAdapter.analyzeSource` is optional in the interface, so the new adapter test needed a non-null assertion; reran focused tests afterward.
- 2026-06-25: Final verification passed: focused Markdown adapter/workflow tests, package manifest test, `npm test` (67 tests), `npm run build`, `node dist/index.js --version` returning `4.7.5`, and full `npm run release:check`. Release benchmark smoke returned resultCount 1, search p95 40ms, health p95 5ms, and event-loop responsive 1/1.
