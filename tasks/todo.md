# v4.8.3 Async Long Tasks

Author: feng.ling

## Goal

Move long summary generation off the request lifecycle so Web/API clients get a task id quickly, can poll task state, and do not hold minute-long HTTP requests while summaries run.

## Plan

- [x] Review existing v4.8.2 summary/task implementation and tests.
- [x] Extend long task tracking to retain queued/running/succeeded/failed task state, result, error, and duration with a bounded in-memory history.
- [x] Add task query endpoints and make `POST /api/summary/generate` start a background summary task returning `202` with `taskId`.
- [x] Update maintenance script and Web UI to poll task state instead of waiting on the summary request.
- [x] Update version strings, README, CHANGELOG, ROADMAP, release checklist, and lessons for v4.8.3.
- [x] Add focused tests for async summary success/failure and task lookup behavior.
- [x] Run focused tests, full `npm test`, `npm run build`, and `npm run release:check`.
- [x] Commit/tag/push and replace the local service.

## Validation Plan

- Focused Web route tests: summary generation returns quickly with a task id, `/api/tasks/:taskId` exposes succeeded state/result, and failures are retained as failed tasks.
- Maintenance script package/contract checks where applicable.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.
- Local service handoff: `/health` reports version `4.8.3` after restart.

## Comments

- 2026-06-30: Started v4.8.3 from v4.8.2. Scope is intentionally in-memory async task orchestration for summary generation; durable task persistence is deferred unless tests expose a hard need.
- 2026-06-30: Implemented async summary task submission, `/api/tasks` polling, Web/script polling, and v4.8.3 docs/version updates. Focused Web route run and `npm run build` passed before full release validation.
- 2026-06-30: Verification passed: focused Web route run, full `npm test` (92 tests), `npm run build`, full `npm run release:check`, `node dist/index.js --version` returning `4.8.3`, and `node dist/index.js --doctor` with only the expected Web port in-use warning.
- 2026-06-30: After adding missing `projectRootPath` validation, final verification passed: full `npm test` (93 tests), `npm run build`, full `npm run release:check`, `node dist/index.js --version` returning `4.8.3`, and doctor with only the expected Web port in-use warning.
- 2026-06-30: Committed `1ca19dd`, tagged `v4.8.3`, pushed `master` and tag to Gitee, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.8.3` on pid `71568`.

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

# v4.7.5 Release Handoff

Author: feng.ling

## Goal

Finish the v4.7.5 release after the commit/tag push by publishing release assets, verifying versioned documentation, and replacing the local Web service with v4.7.5.

## Plan

- [x] Commit `f9e8e7c`, create annotated tag `v4.7.5`, and push `master` plus tag to origin.
- [x] Discover available Gitee release upload mechanism and publish or verify release assets.
- [x] Confirm release docs point at v4.7.5 artifacts.
- [x] Replace local `:8787` service with v4.7.5 and verify `/health`.
- [x] Record final status and any release lessons.

## Validation Plan

- Remote `origin/master` and `refs/tags/v4.7.5^{}` point to `f9e8e7c`.
- Versioned docs/package metadata reference v4.7.5.
- Release assets exist: `ace-mcp-4.7.5.tgz` and `release/ace-mcp-v4.7.5-win-x64.zip`.
- Local `/health` reports version `4.7.5`.

## Comments

- 2026-06-25: User asked to finish v4.7.5 release handoff after commit/tag/push. Starting from pushed commit `f9e8e7c` and existing full `npm run release:check` success.
- 2026-06-25: Created Gitee Release `v4.7.5` in browser, attached `ace-mcp-4.7.5.tgz` (`attach_id=2855447`) and `ace-mcp-v4.7.5-win-x64.zip` (`attach_id=2855448`), and confirmed both release download links redirect to Gitee attach files.
- 2026-06-25: Release edit page confirms the Markdown release notes are saved; Gitee detail page does not render the description in `innerText`, but assets/tag/commit are visible.
- 2026-06-25: Replaced local `:8787` service from pid `34034` (`4.7.4`) to pid `7153`; `/health` reports version `4.7.5`.

# v4.7.6 Vue/Svelte SFC Script Extraction

Author: feng.ling

## Goal

Index Vue and Svelte single-file components by extracting `<script>` / `<script setup>` blocks, reusing the existing JavaScript/TypeScript adapter, and mapping symbols/usages back to original SFC line numbers.

## Plan

- [x] Review lessons and record the task plan before implementation.
- [x] Locate JavaScript adapter, language inference, file collection, and workflow test paths.
- [x] Write failing adapter/workflow tests for Vue and Svelte script extraction.
- [x] Implement a minimal SFC wrapper around the JS/TS analyzer with line-number offset mapping.
- [x] Update default/test extensions so `.vue` and `.svelte` are collected.
- [x] Run focused tests, `npm test`, `npm run build`, and `npm run release:check`.
- [x] Update README, CHANGELOG, ROADMAP, version metadata, and lessons.

## Validation Plan

- Focused adapter regression for Vue `<script setup lang="ts">` symbols/usages mapped to original lines.
- Focused workflow regression proving `.vue` imports resolve and callers/references work.
- Focused workflow regression for `.svelte` script symbols.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.

## Comments

- 2026-06-25: Started v4.7.6 after user approved the SFC plan. Scope is script-only extraction; template deep parsing is intentionally out of scope for this first pass.
- 2026-06-25: RED confirmed: JavaScript adapter currently can mis-index `function` text in SFC style/template content, and workflow tests do not find `.vue`/`.svelte` callers because those extensions are not collected.
- 2026-06-25: GREEN confirmed: JavaScript adapter now analyzes only SFC `<script>` blocks while preserving original line numbers, and `.vue`/`.svelte` workflow call graph tests pass.
- 2026-06-25: Initial full `npm test` passed with 71 tests, but `npm run build` caught a TypeScript narrow-literal array inference issue in the SFC script masking helper. Added `string[]` annotation and reran focused/full tests plus build successfully.
- 2026-06-25: Final verification passed: focused adapter/workflow tests, package manifest test, `npm test` (71 tests), `npm run build`, `node dist/index.js --version` returning `4.7.6`, and full `npm run release:check`. Release benchmark smoke returned resultCount 1, search p95 39ms, health p95 5ms, and event-loop responsive 1/1.

# v4.7.6 Release Handoff

Author: feng.ling

## Goal

Finish the v4.7.6 release after commit/tag/push by publishing release assets, verifying versioned documentation, replacing the local Web service with v4.7.6, and recording a reusable release-handoff rule for future version tasks.

## Plan

- [x] Confirm `origin/master` and annotated tag `v4.7.6` point at the v4.7.6 release commit.
- [x] Verify v4.7.6 docs/package metadata and release assets are present.
- [x] Create or verify the Gitee Release `v4.7.6` with both npm and Windows archive assets.
- [x] Verify release download links redirect successfully.
- [x] Replace local `:8787` service with v4.7.6 and verify `/health`.
- [x] Record release results and future-release lesson, then commit and push the handoff docs.

## Validation Plan

- Remote `origin/master` and `refs/tags/v4.7.6^{}` point to `c6bbc3a`.
- Versioned docs/package metadata reference v4.7.6.
- Release assets exist: `ace-mcp-4.7.6.tgz` and `release/ace-mcp-v4.7.6-win-x64.zip`.
- Gitee download URLs for both assets return a successful redirect chain.
- Local `/health` reports version `4.7.6`.

## Comments

- 2026-06-26: User asked to finish v4.7.6 release handoff and requested future version tasks include this handoff automatically. Starting from pushed commit `c6bbc3a` and existing full `npm run release:check` success.
- 2026-06-26: Remote verification passed: `origin/master` and `refs/tags/v4.7.6^{}` point to `c6bbc3a`, local annotated tag object exists, v4.7.6 package/docs references are present, and release assets exist locally.
- 2026-06-26: Created Gitee Release `v4.7.6` in browser, attached `ace-mcp-4.7.6.tgz` (`attach_id=2857457`) and `ace-mcp-v4.7.6-win-x64.zip` (`attach_id=2857458`), confirmed release detail page shows commit `c6bbc3a`, and confirmed the edit page saved release notes.
- 2026-06-26: Verified both release download links redirect to Gitee attach files and return 200 with expected sizes: tgz `334627` bytes, Windows zip `532987` bytes.
- 2026-06-26: Replaced local `:8787` service from v4.7.5 pid `7153`; `/health` now reports version `4.7.6` on pid `7727`.

# v4.7.7 Vue/Svelte Template Usage Extraction

Author: feng.ling

## Goal

Extract lightweight Vue/Svelte template and markup identifier usages from single-file components, preserving original line numbers and improving `find_references`/RAG recall without adding template-derived caller edges.

## Plan

- [x] Review current SFC script extraction, JavaScript adapter tests, workflow tests, and release/version update paths.
- [x] Write failing Vue/Svelte focused tests for template/markup usages with original SFC line numbers.
- [x] Implement the smallest SFC-only template usage extractor, keeping owner symbols empty to avoid call graph pollution.
- [x] Run focused tests, full `npm test`, and `npm run build`.
- [x] Validate against `~/work/code/tc-flight-endorse-mng` as a real Vue project.
- [x] Update version strings, README, CHANGELOG, ROADMAP, release checklist, and lessons for v4.7.7.
- [x] Run full `npm run release:check` after version/docs updates.
- [x] Fix Windows zip release contract so checklist-mentioned smoke/benchmark scripts are actually packaged.
- [x] Commit, tag, push, create/verify Gitee Release assets, replace local `:8787`, and record handoff.

## Validation Plan

- Focused adapter regression proving Vue template expressions/tags produce usage records at original SFC lines.
- Focused adapter regression proving Svelte markup expressions/events/bindings produce usage records at original SFC lines.
- Workflow regression proving template usages are searchable as references but not treated as callers.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.
- Real Vue project smoke using `~/work/code/tc-flight-endorse-mng`.

## Comments

- 2026-06-26: Started v4.7.7 after user approved the SFC-template follow-up and asked to use `~/work/code/tc-flight-endorse-mng` for Vue project testing. Relevant lessons reviewed: keep SFC parsing script/template scoped, preserve UTF-16 offset alignment, do not set `ownerSymbol` for doc-like usages unless intentionally affecting callers, and include release handoff before final response.
- 2026-06-26: RED confirmed: Vue/Svelte adapter tests failed because template/markup identifiers were not extracted, and workflow failed because `@click="checkout"` did not resolve as a reference.
- 2026-06-26: GREEN confirmed: Vue template tags/directives/interpolations and Svelte markup tags/brace expressions now emit ownerless `usage` records; workflow proves template references resolve while callers stay empty.
- 2026-06-26: Added a second RED/GREEN edge for Vue directive modifiers and lowercase registered components after inspecting `tc-flight-endorse-mng`; `@submit.stop` and `<hamburger>` are now covered.
- 2026-06-26: Verification passed before version bump: focused adapter/workflow tests, `npm test` (74 tests), and `npm run build`.
- 2026-06-26: Real Vue project smoke passed on isolated port `8797`: indexed `~/work/code/tc-flight-endorse-mng` with 315 scanned/indexed files, 430 chunks, 0 failed files; `find-references toggleSideBar` found `src/layout/components/Navbar.vue` line 3 from template usage, while `find-callers toggleSideBar` returned no template caller.
- 2026-06-26: Version/docs updated to v4.7.7. Full `npm run release:check` passed: `npm test` (74 tests), build, tgz pack, Windows zip, release smoke, and benchmark smoke. Benchmark smoke returned resultCount 1, search p95 41ms, health p95 6ms, and event-loop responsive 1/1.
- 2026-06-26: Manual package content check found a release contract gap: the Windows zip checklist mentioned `benchmark-search.mjs`, but `scripts/package-windows.mjs` did not stage benchmark/smoke release scripts and the broad `rg` pattern did not catch the missing file. Pausing to add a focused packaging contract test and fix the zip contents before commit/tag.
- 2026-06-26: Added a failing package manifest test for Windows zip release scripts, staged `scripts/smoke-release.mjs` and `scripts/benchmark-search.mjs` into the Windows zip, regenerated the archive, and confirmed both files are present. Reran full `npm run release:check`; final benchmark smoke returned resultCount 1, search p95 40ms, health p95 6ms, and event-loop responsive 1/1.
- 2026-06-26: Committed `461fb96`, tagged `v4.7.7`, pushed `master` and `v4.7.7`, created the Gitee Release, uploaded both assets, verified download links, and replaced local `:8787` with v4.7.7.

# v4.7.7 Release Handoff

Author: feng.ling

## Goal

Finish the v4.7.7 release after commit/tag/push by publishing release assets, verifying download links, replacing the local Web service with v4.7.7, and recording the handoff separately from the tagged release commit.

## Plan

- [x] Confirm `origin/master` and annotated tag `v4.7.7` point at the v4.7.7 release commit.
- [x] Verify v4.7.7 docs/package metadata and release assets are present.
- [x] Create the Gitee Release `v4.7.7` with npm and Windows archive assets.
- [x] Verify release download links redirect successfully.
- [x] Replace local `:8787` service with v4.7.7 and verify `/health`.
- [x] Record release handoff results and push the handoff docs.

## Validation Plan

- Remote `origin/master` and `refs/tags/v4.7.7^{}` point to `461fb96`.
- Versioned docs/package metadata reference v4.7.7.
- Release assets exist: `ace-mcp-4.7.7.tgz` and `release/ace-mcp-v4.7.7-win-x64.zip`.
- Gitee download URLs for both assets return a successful redirect chain.
- Local `/health` reports version `4.7.7`.

## Comments

- 2026-06-26: Remote verification passed: `origin/master` and `refs/tags/v4.7.7^{}` point to `461fb96`, local annotated tag object exists, v4.7.7 package/docs references are present, and release assets exist locally.
- 2026-06-26: Created Gitee Release `v4.7.7` in browser, attached `ace-mcp-4.7.7.tgz` (`attach_id=2857846`) and `ace-mcp-v4.7.7-win-x64.zip` (`attach_id=2857847`), confirmed release detail page shows commit `461fb96`, and confirmed the edit page saved release notes.
- 2026-06-26: Verified both release download links redirect to Gitee attach files and return 200 with expected sizes: tgz `337577` bytes, Windows zip `544395` bytes.
- 2026-06-26: Replaced local `:8787` service from v4.7.6 pid `7727`; `/health` now reports version `4.7.7` on pid `34664`.

# v4.7.9 Vue Options API Symbol Extraction

Author: feng.ling

## Goal

Close the real Vue 2 gap exposed by `~/work/code/tc-flight-endorse-mng`: template usages are now indexed, but Options API methods/computed/watch handlers may not be indexed as symbols, so references such as `@change="changeLanguage"` and `@click="search"` cannot always resolve back to component method definitions.

## Plan

- [x] Review current JavaScript/SFC adapter and workflow tests.
- [x] Write failing adapter tests for Vue Options API `methods`, `computed`, `watch`, and lifecycle symbols with original `.vue` line numbers.
- [x] Write a failing workflow test proving template references resolve to Options API component method definitions without creating template caller edges.
- [x] Implement minimal Vue-only Options API symbol extraction on top of the existing SFC script masking path.
- [x] Keep template/markup usages ownerless so `find_references` improves without adding template caller edges.
- [x] Validate against `tc-flight-endorse-mng` files such as `src/layout/components/Navbar.vue` and `src/views/endorse-lookup/index.vue`.
- [x] Run focused tests, `npm test`, `npm run build`, and `npm run release:check`.
- [x] Update version strings, README, CHANGELOG, ROADMAP, release checklist, and lessons.
- [x] Commit, tag, push, create/verify Gitee Release assets, replace local `:8787`, and record handoff if release validation passes.

## Validation Plan

- Focused JavaScript adapter regression for Vue Options API symbols and original SFC line numbers.
- Workflow regression proving template usages resolve as references to Options API methods while `find_callers` remains clean.
- Real Vue project smoke against `~/work/code/tc-flight-endorse-mng`.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.

## Comments

- 2026-06-26: Recorded for v4.7.9 at user request after v4.7.7 real-project validation showed `toggleSideBar` could be found as a template reference, while Options API entries like `changeLanguage` and `search` were not always available as definitions.
- 2026-06-29: Started implementation after user approved completing Vue Options API support. Reviewed relevant lessons: keep SFC parsing scoped, preserve original line numbers, leave template usages ownerless, and include release handoff before final response.
- 2026-06-29: RED confirmed: JavaScript adapter did not emit `EndorseLookup.displayName/search/changeLanguage` symbols from `export default { computed/watch/methods }`, and workflow definition lookup for `EndorseLookup.search` failed.
- 2026-06-29: GREEN confirmed: `.vue` Options API default export now sets a component context from `name` or filename, emits `methods/computed/watch/lifecycle` members as method symbols, preserves original SFC lines, and leaves template usages ownerless.
- 2026-06-29: Validation passed before release packaging: focused JavaScript adapter test, focused search workflow test, `npm test` (78 tests), `npm run build`, and real Vue project smoke. Real smoke indexed 315 files / 541 chunks / 0 failures in `tc-flight-endorse-mng`; `EndorseLookup.search` line 263 and `Navbar.changeLanguage` line 128 resolve as definitions, template references resolve, and `mounted -> search` caller resolves without template caller pollution.
- 2026-06-29: Full release validation passed: `npm run release:check` ran `npm test` (78 tests), build, tgz pack, Windows zip, release smoke, and benchmark smoke. Benchmark smoke returned resultCount 1, search p95 37ms, health p95 5ms, and event-loop responsive 1/1.
- 2026-06-29: Committed `a302cc0`, tagged `v4.7.9`, pushed `master` and `v4.7.9`, created the Gitee Release, uploaded both assets, verified download links, and replaced local `:8787` with v4.7.9.

# v4.7.9 Release Handoff

Author: feng.ling

## Goal

Finish the v4.7.9 release after commit/tag/push by publishing release assets, verifying download links, replacing the local Web service with v4.7.9, and recording the handoff separately from the tagged release commit.

## Plan

- [x] Confirm `origin/master` and annotated tag `v4.7.9` point at the v4.7.9 release commit.
- [x] Verify v4.7.9 docs/package metadata and release assets are present.
- [x] Create the Gitee Release `v4.7.9` with npm and Windows archive assets.
- [x] Verify release download links redirect successfully.
- [x] Replace local `:8787` service with v4.7.9 and verify `/health`.
- [x] Record release handoff results and push the handoff docs.

## Validation Plan

- Remote `origin/master` and `refs/tags/v4.7.9^{}` point to `a302cc0`.
- Versioned docs/package metadata reference v4.7.9.
- Release assets exist: `ace-mcp-4.7.9.tgz` and `release/ace-mcp-v4.7.9-win-x64.zip`.
- Gitee download URLs for both assets return a successful redirect chain.
- Local `/health` reports version `4.7.9`.

## Comments

- 2026-06-29: Remote verification passed: `origin/master` and `refs/tags/v4.7.9^{}` point to `a302cc0`, local annotated tag object exists, v4.7.9 package/docs references are present, and release assets exist locally.
- 2026-06-29: Created Gitee Release `v4.7.9` in browser, attached `ace-mcp-4.7.9.tgz` (`attach_id=2864042`) and `ace-mcp-v4.7.9-win-x64.zip` (`attach_id=2864043`), confirmed release detail page shows commit `a302cc0`, and confirmed the edit page saved release notes.
- 2026-06-29: Verified both release download links redirect to Gitee attach files and return 200 with expected sizes: tgz `340338` bytes, Windows zip `548962` bytes.
- 2026-06-29: Replaced local `:8787` service from v4.7.8 pid `80870`; `/health` now reports version `4.7.9` on pid `13829`.

# v4.7.10 Vue Options API Data/Props Symbol Extraction

Author: feng.ling

## Goal

Complete the next small Vue 2 Options API gap after v4.7.9: template usages can now resolve methods/computed/watch/lifecycle definitions, but state fields from `props` and `data()` are not stable definition targets. Extract these as component `property` symbols so template references such as `v-model="currentLang"` and `{{ avatar }}` can resolve back to component state definitions without changing caller behavior.

## Plan

- [x] Review v4.7.9 Vue Options API extraction and existing SFC tests.
- [x] Write failing adapter tests for `props` and `data()` return object fields with original `.vue` line numbers.
- [x] Write a failing workflow test proving template references resolve to Options API properties without creating caller edges.
- [x] Implement minimal Vue-only property extraction for `props` object/array forms and `data()` object returns.
- [x] Keep template/markup usages ownerless so `find_references` improves without adding template caller edges.
- [x] Validate against `tc-flight-endorse-mng` files such as `src/layout/components/Navbar.vue`.
- [x] Run focused tests, `npm test`, `npm run build`, and `npm run release:check`.
- [x] Update version strings, README, CHANGELOG, ROADMAP, release checklist, and lessons.
- [x] Commit, tag, push, create/verify Gitee Release assets, replace local `:8787`, and record handoff if release validation passes.

## Validation Plan

- Focused JavaScript adapter regression for Vue `props` and `data()` property symbols and original SFC line numbers.
- Workflow regression proving template usages resolve as references to Options API properties while `find_callers` remains clean.
- Real Vue project smoke against `~/work/code/tc-flight-endorse-mng`.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.

## Comments

- 2026-06-29: Started v4.7.10 after user approved the small high-value follow-up. Scope is intentionally limited to Vue Options API `props` and `data()` state symbols; methods/computed/watch/lifecycle were completed in v4.7.9.
- 2026-06-29: RED confirmed: JavaScript adapter did not emit `Navbar.avatar/currentLang/theme` property symbols from `props` and `data()`, and workflow definition lookup for `Navbar.currentLang` failed.
- 2026-06-29: GREEN confirmed: `.vue` Options API `props` object/array forms and `data()` returned object fields now emit component `property` symbols with original SFC lines, while template usages remain ownerless.
- 2026-06-29: Validation passed before release packaging: focused JavaScript adapter test, focused search workflow test, `npm test` (80 tests), `npm run build`, and real Vue project smoke. Real smoke indexed 315 files / 544 chunks / 0 failures in `tc-flight-endorse-mng`; `Navbar.currentLang` line 62, `Pagination.total` line 23, and `Pagination.hidden` line 53 resolve as property definitions, template references resolve, and property queries have no template caller pollution.
- 2026-06-29: After the release commit/tag push, user requested macOS installation docs. Added a README macOS installation section covering Node LTS via Homebrew, Gitee tgz install, source install, and Xcode Command Line Tools fallback for `better-sqlite3`.
- 2026-06-29: Final release validation passed after adding macOS docs: `npm run release:check` ran `npm test` (80 tests), build, tgz pack, Windows zip, release smoke, and benchmark smoke. Benchmark smoke returned resultCount 1, search p95 38ms, health p95 5ms, and event-loop responsive 1/1.
- 2026-06-29: Committed `7285cb5`, tagged `v4.7.10`, pushed `master` and `v4.7.10`; then committed macOS install docs as `185e2d8` on master. Created the Gitee Release, uploaded regenerated assets containing the macOS README section, verified download links, and replaced local `:8787` with v4.7.10.

# v4.7.10 Release Handoff

Author: feng.ling

## Goal

Finish the v4.7.10 release after commit/tag/push by publishing release assets, verifying download links, replacing the local Web service with v4.7.10, and recording the handoff separately from the tagged release commit.

## Plan

- [x] Confirm `origin/master` and annotated tag `v4.7.10` are pushed.
- [x] Verify v4.7.10 docs/package metadata and release assets are present.
- [x] Create the Gitee Release `v4.7.10` with npm and Windows archive assets.
- [x] Verify release download links redirect successfully.
- [x] Replace local `:8787` service with v4.7.10 and verify `/health`.
- [x] Record release handoff results and push the handoff docs.

## Validation Plan

- Remote `refs/tags/v4.7.10^{}` points to `7285cb5`.
- Remote `origin/master` includes the release commit and macOS install docs commit `185e2d8`.
- Versioned docs/package metadata reference v4.7.10.
- Release assets exist: `ace-mcp-4.7.10.tgz` and `release/ace-mcp-v4.7.10-win-x64.zip`.
- Gitee download URLs for both assets return a successful redirect chain.
- Local `/health` reports version `4.7.10`.

## Comments

- 2026-06-29: Remote verification passed: `refs/tags/v4.7.10^{}` points to release commit `7285cb5`; `origin/master` advanced to macOS-doc commit `185e2d8`; v4.7.10 package/docs references are present, and regenerated release assets exist locally.
- 2026-06-29: Created Gitee Release `v4.7.10` in browser, attached `ace-mcp-4.7.10.tgz` (`attach_id=2864341`) and `ace-mcp-v4.7.10-win-x64.zip` (`attach_id=2864342`), confirmed release detail page shows commit `7285cb5`, and confirmed the edit page saved release notes.
- 2026-06-29: Verified both release download links redirect to Gitee attach files and return 200 with expected sizes: tgz `342172` bytes, Windows zip `551745` bytes.
- 2026-06-29: Replaced local `:8787` service from v4.7.9 pid `13829`; `/health` now reports version `4.7.10` on pid `52159`.

# v4.7.11 Larger Snippet Limits and Max Shortcuts

Author: feng.ling

## Goal

Improve Web page ergonomics for large files and advanced options: raise the safe maximum for code snippet/search context expansion and add "最大" shortcuts for every numeric advanced option that has a bounded backend maximum.

## Plan

- [x] Review current request validation constants and Web static controls for search, snippet, call graph, and QA advanced options.
- [x] Write failing tests for the larger snippet/search context limit.
- [x] Write failing Web static contract tests requiring max buttons for all bounded advanced numeric options.
- [x] Implement shared limit changes and UI max buttons without changing indexing/search semantics.
- [x] Run focused tests, `npm test`, `npm run build`, and `npm run release:check`.
- [x] Update README, CHANGELOG, ROADMAP, version metadata, and lessons if needed.
- [x] Commit, tag, push, create/verify Gitee Release assets, replace local `:8787`, and record handoff if release validation passes.

## Validation Plan

- Request/schema tests prove the new larger context limit is accepted and unsafe values still clamp.
- Web static contract test proves all bounded advanced numeric controls have max shortcut buttons.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.

## Comments

- 2026-06-29: Started after user asked whether code snippet maximum can be increased further and whether every advanced option can provide a "最大" shortcut. Scope is limited to bounded request options and Web controls.
- 2026-06-29: RED confirmed the old `includeContextLines` cap was still 200 and Web static contracts lacked max shortcuts for all bounded advanced numeric options.
- 2026-06-29: GREEN confirmed `includeContextLines` now accepts/clamps at 500 and Web controls include max shortcuts for search result count, context lines, file snippet range, QA source count, QA context budget, max output tokens, timeout, and retries.
- 2026-06-29: While validating the advanced options, found the existing QA retries input was not sent to the backend. Added request parsing, frontend request wiring, route/pipeline propagation, and LLM client retry coverage so the option is functional rather than cosmetic.
- 2026-06-29: Focused verification passed: `node --import tsx --test src/core/llm/llmClient.test.ts src/core/validation/schemas.test.ts src/web/requestValidation.test.ts src/config/packageManifest.test.ts`; `npm run build`.
- 2026-06-29: Full verification passed after adding non-streaming and streaming LLM retry coverage to `npm test`: `npm test` (83 tests), `npm run build`, `node dist/index.js --version` (`4.7.11`), and full `npm run release:check`. Release benchmark smoke returned resultCount 1, search p95 38ms, health p95 5ms, event-loop responsive 1/1.
- 2026-06-29: Committed `378044b`, tagged `v4.7.11`, pushed `master` and `v4.7.11`, created the Gitee Release, uploaded both assets, verified download links, and replaced local `:8787` with v4.7.11.

# v4.7.11 Release Handoff

Author: feng.ling

## Goal

Finish the v4.7.11 release after commit/tag/push by publishing release assets, verifying download links, replacing the local Web service with v4.7.11, and recording the handoff separately from the tagged release commit.

## Plan

- [x] Confirm release commit and annotated tag were pushed.
- [x] Create the Gitee Release `v4.7.11` with npm and Windows archive assets.
- [x] Verify release notes are saved on the edit page.
- [x] Verify both release download links return expected files.
- [x] Replace local `:8787` service with v4.7.11 and verify served assets.
- [x] Record final handoff results and push the handoff docs.

## Validation Plan

- Remote `origin/master` and `refs/tags/v4.7.11^{}` point to release commit `378044b`.
- Release assets exist: `ace-mcp-4.7.11.tgz` and `release/ace-mcp-v4.7.11-win-x64.zip`.
- Gitee download URLs for both assets return 200 with expected sizes.
- Local `/health` reports version `4.7.11`.
- Local served `/static/index.html` and `/static/js/app.js` include the new max shortcut controls and `retries` request wiring.

## Comments

- 2026-06-29: Remote release commit `378044b` was pushed to `master`; annotated tag `v4.7.11` was pushed to Gitee.
- 2026-06-29: Created Gitee Release `v4.7.11`, attached `ace-mcp-4.7.11.tgz` (`attach_id=2864446`) and `ace-mcp-v4.7.11-win-x64.zip` (`attach_id=2864445`), and confirmed the edit page saved release notes.
- 2026-06-29: Verified release download links return 200 with expected sizes: tgz `343599` bytes, Windows zip `555095` bytes.
- 2026-06-29: Replaced local `:8787` service from v4.7.10 pid `52159`; `/health` now reports version `4.7.11` on pid `7903`. Served `/static/index.html` includes `include-context-lines max="500"`, `top-k-max`, and `qa-retries-max`; served `/static/js/app.js` includes `MAX_INCLUDE_CONTEXT_LINES = 500`, `QA_RETRIES_MAX = 5`, and `retries` in the QA request body.

# v4.7.12 Web Runtime Visibility

Author: feng.ling

## Goal

Make the Web page more self-explanatory during daily use: show service/runtime status, show current/max values for bounded advanced numeric options, and echo the actual QA request parameters used for each answer.

## Plan

- [x] Review Web static layout, `/health`, QA SSE done payload, and current option wiring.
- [x] Write failing static contract tests for the service status strip, bounded value hints, and QA parameter echo.
- [x] Write failing route/request tests proving QA responses emit parsed request parameters.
- [x] Implement the smallest frontend/backend changes without touching indexing/search core behavior.
- [x] Run focused tests, `npm test`, `npm run build`, and `npm run release:check`.
- [x] Update README, CHANGELOG, ROADMAP, version metadata, and lessons if needed.
- [x] Commit, tag, push, create/verify Gitee Release assets, replace local `:8787`, and record handoff if release validation passes.

## Validation Plan

- Static contract tests prove the Web page exposes status and current/max option hints.
- QA route or request tests prove the backend emits actual parsed QA parameters.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.

## Comments

- 2026-06-29: Started after user approved the v4.7.12 plan. Scope is Web visibility and QA request parameter observability only.
- 2026-06-29: RED confirmed Web static page lacked service status/effective request parameter UI and `parseAskRequest` did not expose clamped effective parameters.
- 2026-06-29: GREEN confirmed Web header renders `/health` status, bounded numeric inputs render current/max hints, QA responses include effective request parameters, and the QA page displays them after completion.
- 2026-06-29: Verification passed: focused tests (`src/config/packageManifest.test.ts`, `src/web/requestValidation.test.ts`, `src/web/app.test.ts`), `npm test` (86 tests), `npm run build`, `node dist/index.js --version` (`4.7.12`), and full `npm run release:check`. Release benchmark smoke returned resultCount 1, search p95 47ms, health p95 6ms, event-loop responsive 1/1.
- 2026-06-29: Explicit package checks passed for `ace-mcp-4.7.12.tgz` and `release/ace-mcp-v4.7.12-win-x64.zip`; both include `dist/index.js`, packaged start/install scripts, benchmark/smoke scripts, and `dist/web/static/js/app.js`. `git diff --check` passed.
- 2026-06-29: Committed `b65e38a`, tagged `v4.7.12`, pushed `master` and `v4.7.12`, created the Gitee Release, uploaded both assets, verified download links, and replaced local `:8787` with v4.7.12.

# v4.7.12 Release Handoff

Author: feng.ling

## Goal

Finish the v4.7.12 release after commit/tag/push by publishing release assets, verifying download links, replacing the local Web service with v4.7.12, and recording the handoff separately from the tagged release commit.

## Plan

- [x] Confirm release commit and annotated tag were pushed.
- [x] Create the Gitee Release `v4.7.12` with npm and Windows archive assets.
- [x] Verify release notes are saved on the edit page.
- [x] Verify both release download links return expected files.
- [x] Replace local `:8787` service with v4.7.12 and verify served assets.
- [x] Record final handoff results and push the handoff docs.

## Validation Plan

- Remote `origin/master` and `refs/tags/v4.7.12^{}` point to release commit `b65e38a`.
- Release assets exist: `ace-mcp-4.7.12.tgz` and `release/ace-mcp-v4.7.12-win-x64.zip`.
- Gitee download URLs for both assets return 200 with expected sizes.
- Local `/health` reports version `4.7.12`.
- Local served `/static/index.html` includes `service-status-strip`, `qa-effective-params`, and `data-value-hint="qa-retries"`.
- Local served `/static/js/app.js` includes `renderServiceStatus`, `renderQaEffectiveParams`, and `finalData?.request` handling.

## Comments

- 2026-06-29: Remote release commit `b65e38a` was pushed to `master`; annotated tag `v4.7.12` was pushed to Gitee.
- 2026-06-29: Created Gitee Release `v4.7.12`, attached `ace-mcp-4.7.12.tgz` (`attach_id=2864588`) and `ace-mcp-v4.7.12-win-x64.zip` (`attach_id=2864587`), and confirmed the edit page saved release notes.
- 2026-06-29: Verified release download links return 200 with expected sizes: tgz `345844` bytes, Windows zip `558277` bytes.
- 2026-06-29: Replaced local `:8787` service from v4.7.11 pid `7903` by restarting LaunchAgent `com.ace-mcp.server`; `/health` now reports version `4.7.12` on pid `56471`. Served `/static/index.html` includes `service-status-strip`, `qa-effective-params`, and `data-value-hint="qa-retries"`; served `/static/js/app.js` includes `renderServiceStatus`, `renderQaEffectiveParams`, and `finalData?.request`.

# v4.8.1 Java Annotation and Interface Entry Recall

Author: feng.ling

## Goal

Improve Java business-project recall by indexing Spring-style annotation entry points and making interface method queries surface implementation methods more reliably, especially for Controller/Service projects such as `tc-flight-tgq-core`.

## Plan

- [x] Review lessons and record the implementation plan before code changes.
- [x] Locate Java symbol/usage extraction and definition/reference resolution paths.
- [x] Write failing Java adapter/workflow tests for annotation/path indexing and interface-to-implementation lookup.
- [x] Implement the smallest Java-only extraction/resolution changes without perturbing other languages.
- [x] Run focused tests, `npm test`, `npm run build`, and `npm run release:check`.
- [x] Update README, CHANGELOG, ROADMAP, version metadata, and lessons if needed.
- [x] Commit, tag, push, create/verify Gitee Release assets, replace local `:8787`, and record handoff if release validation passes.

## Validation Plan

- Focused Java adapter tests prove annotations and HTTP paths are extracted from classes/methods.
- Focused search workflow tests prove `/path` and Spring annotation queries find Controller methods.
- Focused call/reference test proves interface method lookup surfaces implementation methods.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.

## Comments

- 2026-06-29: Started after user selected the Java annotation/interface entry recall work and set version to `v4.8.1`. Scope is Java-only extraction/resolution plus release metadata.
- 2026-06-29: RED confirmed Java adapter did not extract mapping paths, `/api/refund/apply` could not reliably find Controller entry context, and interface method lookup did not include implementation methods/callers.
- 2026-06-29: GREEN confirmed Java mapping annotations emit class/method path usages, field-typed method calls resolve to interface methods, interface queries include implementation method definitions, and call graph lookup uses all matched definition candidates for interface/impl caller recall.
- 2026-06-29: Verification passed: focused Java/package tests, `npm test` (88 tests), `npm run build`, `node dist/index.js --version` (`4.8.1`), and full `npm run release:check`. Release benchmark smoke returned resultCount 1, search p95 35ms, health p95 5ms, event-loop responsive 1/1.
- 2026-06-29: Explicit package checks passed for `ace-mcp-4.8.1.tgz` and `release/ace-mcp-v4.8.1-win-x64.zip`; both include `dist/index.js`, `dist/adapters/java/index.js`, packaged start/install scripts, benchmark/smoke scripts, and Windows README. `git diff --check` passed.
- 2026-06-29: Committed `bac1bc9`, tagged `v4.8.1`, pushed `master` and `v4.8.1`, created the Gitee Release, uploaded both assets, verified download links, and replaced local `:8787` with v4.8.1.

# v4.8.1 Release Handoff

Author: feng.ling

## Goal

Finish the v4.8.1 release after commit/tag/push by publishing release assets, verifying download links, replacing the local Web service with v4.8.1, and recording the handoff separately from the tagged release commit.

## Plan

- [x] Confirm release commit and annotated tag were pushed.
- [x] Create the Gitee Release `v4.8.1` with npm and Windows archive assets.
- [x] Verify release notes are saved on the edit page.
- [x] Verify both release download links return expected files.
- [x] Replace local `:8787` service with v4.8.1 and verify served runtime.
- [x] Record final handoff results and push the handoff docs.

## Validation Plan

- Remote `origin/master` and `refs/tags/v4.8.1^{}` point to release commit `bac1bc9`.
- Release assets exist: `ace-mcp-4.8.1.tgz` and `release/ace-mcp-v4.8.1-win-x64.zip`.
- Gitee download URLs for both assets return 200 with expected sizes.
- Local `/health` reports version `4.8.1`.
- Built Java adapter includes Spring mapping path extraction and field-type call resolution.

## Comments

- 2026-06-29: Remote release commit `bac1bc9` was pushed to `master`; annotated tag `v4.8.1` was pushed to Gitee.
- 2026-06-29: Created Gitee Release `v4.8.1`, attached `ace-mcp-4.8.1.tgz` (`attach_id=2864901`) and `ace-mcp-v4.8.1-win-x64.zip` (`attach_id=2864899`), and confirmed the edit page saved release notes.
- 2026-06-29: Verified release download links return 200 with expected sizes: tgz `348081` bytes, Windows zip `562019` bytes.
- 2026-06-29: Replaced local `:8787` service from v4.7.12 pid `56471` by restarting LaunchAgent `com.ace-mcp.server`; `/health` now reports version `4.8.1` on pid `54763`. Built `dist/adapters/java/index.js` includes `MAPPING_ANNOTATIONS`, `joinMappingPath`, and `fieldTypes` resolution logic.

# v4.7.8 Snippet/Context Maximum Controls

Author: feng.ling

## Goal

Reduce missed-code risk by allowing larger snippet/context windows where the backend can safely support them, and add Web UI "max" shortcuts near snippet/context controls so users do not need to type the maximum values manually.

## Plan

- [x] Locate current request validation limits for snippet context, search context lines, QA sources, and QA context tokens.
- [x] Write failing tests for higher backend limits and front-end maximum shortcut controls.
- [x] Implement shared limit constants and Web UI max buttons near the relevant controls.
- [x] Run focused tests, `npm test`, `npm run build`, and update docs/tasks/lessons.
- [x] If versioning as v4.7.8, run release validation and release handoff.

## Validation Plan

- Request validation tests prove larger snippet/search context values are accepted and unsafe values are still clamped.
- Front-end static contract test proves "max" buttons exist for snippet/search/QA context controls and use the same maximum values.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.

## Comments

- 2026-06-26: Started after user asked whether snippet size can be increased and requested maximum shortcut buttons near code snippet/context controls.
- 2026-06-26: RED confirmed: focused request/schema/static tests fail because search context is still capped at 50 and the Web UI lacks max shortcut buttons plus `maxContextTokens` wiring.
- 2026-06-26: GREEN confirmed: search context line cap is 200, Web static UI has max buttons for search context, file snippet range, QA sources, and QA context tokens, and the QA SSE request now sends `maxContextTokens`. Focused request/schema/static tests pass.
- 2026-06-26: Validation passed: focused request/schema/static tests; `npm test` (76 tests); `npm run build`; `node dist/index.js --version` returning `4.7.8`; full `npm run release:check`; explicit tgz/Windows zip content checks; dist static checks for max buttons and `maxContextTokens`. Release benchmark smoke returned resultCount 1, search p95 39ms, health p95 5ms, event-loop responsive 1/1.
- 2026-06-26: Committed `5a86ed1`, tagged `v4.7.8`, pushed `master` and `v4.7.8`, created the Gitee Release, uploaded both assets, verified download links, and replaced local `:8787` with v4.7.8.

# v4.7.8 Release Handoff

Author: feng.ling

## Goal

Finish the v4.7.8 release after commit/tag/push by publishing release assets, verifying download links, replacing the local Web service with v4.7.8, and recording the handoff separately from the tagged release commit.

## Plan

- [x] Confirm `origin/master` and annotated tag `v4.7.8` point at the v4.7.8 release commit.
- [x] Verify v4.7.8 docs/package metadata and release assets are present.
- [x] Create the Gitee Release `v4.7.8` with npm and Windows archive assets.
- [x] Verify release download links redirect successfully.
- [x] Replace local `:8787` service with v4.7.8 and verify `/health`.
- [x] Record release handoff results and push the handoff docs.

## Validation Plan

- Remote `origin/master` and `refs/tags/v4.7.8^{}` point to `5a86ed1`.
- Versioned docs/package metadata reference v4.7.8.
- Release assets exist: `ace-mcp-4.7.8.tgz` and `release/ace-mcp-v4.7.8-win-x64.zip`.
- Gitee download URLs for both assets return a successful redirect chain.
- Local `/health` reports version `4.7.8`.
- Local served `/static/index.html` includes the new max shortcut buttons.

## Comments

- 2026-06-26: Remote verification passed: `origin/master` and `refs/tags/v4.7.8^{}` point to `5a86ed1`, local annotated tag object exists, v4.7.8 package/docs references are present, and release assets exist locally.
- 2026-06-26: Created Gitee Release `v4.7.8` in browser, attached `ace-mcp-4.7.8.tgz` (`attach_id=2858465`) and `ace-mcp-v4.7.8-win-x64.zip` (`attach_id=2858466`), confirmed release detail page shows commit `5a86ed1`, and confirmed the edit page saved release notes.
- 2026-06-26: Verified both release download links redirect to Gitee attach files and return 200 with expected sizes: tgz `338657` bytes, Windows zip `546330` bytes.
- 2026-06-26: Replaced local `:8787` service from v4.7.7 pid `34664`; `/health` now reports version `4.7.8` on pid `57607`, and served `/static/index.html` contains the search/snippet/QA max shortcut buttons.

# v4.8.1 Local Project Full Reindex And Summaries

Author: feng.ling

## Goal

Full reindex all concrete registered local ace-mcp projects after the v4.8.1 Java analysis release, then generate project summaries for the same projects where the summary endpoint succeeds.

## Plan

- [x] Review ace-mcp usage guidance and existing operational lessons.
- [x] Confirm the local v4.8.1 LaunchAgent service state before sending more work.
- [x] Let any already queued full-index work finish or recover the service only if it is stuck.
- [x] Reconcile registered projects with index logs/stats and skip missing paths plus the parent `/Users/fengandrew/work/code` aggregate directory unless explicitly requested.
- [x] Full-index remaining concrete projects sequentially.
- [x] Generate summaries sequentially for every successfully indexed concrete project.
- [x] Verify final project stats and record indexed/summary/skipped results.

## Validation Plan

- `/health` responds on local `:8787` with version `4.8.1` after heavy work drains.
- `project indexed` logs or project stats confirm full indexing for each processed project.
- `Project summary generated` logs or summary endpoint responses confirm summary generation.
- Missing paths and intentionally deferred aggregate parent path are reported explicitly.

## Comments

- 2026-06-29: Started from an earlier batch full-index request that timed out client-side while the LaunchAgent continued processing queued index jobs. Avoiding concurrent index/summary requests until `/health` becomes responsive.
- 2026-06-29: Confirmed service is LaunchAgent-managed at `com.ace-mcp.server`, pid `54763`, version `4.8.1`; logs show full indexes continuing through at least `/Users/fengandrew/work/code/tc-flight-mail-itinerary-core_backup`.
- 2026-06-29: The queued full-index batch continued through many concrete projects, then stalled with `/health` timing out and no new index completion logs for more than 20 minutes. Recovered by restarting LaunchAgent; `/health` returned version `4.8.1` on pid `57957`.
- 2026-06-29: Reconciled project logs/stats and skipped the aggregate parent `/Users/fengandrew/work/code` plus missing paths `/Users/fengandrew/work/code/tc-flight-endorse-postcore-backup` and `/Users/fengandrew/.copilot/session-state/edb31bf5-3e71-440d-91b3-e1301ca37a26/files/index-resilience-smoke`.
- 2026-06-29: Filled the two missing concrete full indexes manually: `/Users/fengandrew/work/code/tc-flight-flightchange-admin` indexed 3129 files / 6433 chunks / 0 failed, and `/Users/fengandrew/work/code/tc-flight-internationcore` indexed 362 files / 749 chunks / 0 failed.
- 2026-06-29: Generated summaries for all 26 concrete existing projects. Final file check found `SUMMARY_MISSING=0`; service health remained ok on v4.8.1 with no active indexing. Some summaries reused cached module summaries where content hashes matched existing summaries.

# v4.8.2 Long Task Visibility And Maintenance Script

Author: feng.ling

## Goal

Make long-running index/summary maintenance safer and easier to observe after the v4.8.1 full-library maintenance exposed client timeout ambiguity, parent-directory mis-scan risk, and missing summary task visibility.

## Plan

- [x] Review existing index coordinator, summary route, health route, and release script patterns.
- [x] Add lightweight long-task tracking so `/health` exposes active summary generation alongside indexing state.
- [x] Add parent-directory risk detection to Web full-index requests so aggregate roots require explicit confirmation.
- [x] Add a sequential `scripts/reindex-projects.mjs` maintenance script for full index + optional summary generation with missing/parent skips and a final report.
- [x] Add focused tests for health task visibility, parent-root guard, and package/script contracts.
- [x] Update version metadata, README, CHANGELOG, ROADMAP, release checklist, and lessons.
- [x] Run focused tests, full `npm test`, build, and release validation.

## Validation Plan

- Web `/health` includes active summary task details without reading deep project stats.
- `POST /api/index-project` rejects risky full indexes on registered parent directories unless `confirmParentDirectory: true` is supplied.
- `scripts/reindex-projects.mjs --dry-run` reports concrete/missing/parent projects without triggering work.
- Package manifest and Windows zip staging include the new maintenance script.
- Full test/build/release checks pass before handoff.

## Comments

- 2026-06-30: Started after local full-library maintenance required manual log watching, LaunchAgent recovery, and summary file reconciliation. Scope is intentionally operational: visibility, guardrails, and repeatable maintenance, not search ranking changes.
- 2026-06-30: Implemented `LongTaskTracker`, exposed `/health.tasks`, tracked summary generation, guarded Web full-index requests for aggregate parent directories, and added `scripts/reindex-projects.mjs` with dry-run/summary/include-parent options.
- 2026-06-30: Focused validation passed for Web health task visibility, parent-directory confirmation, package script contracts, and local maintenance dry-run against the running v4.8.1 service.
- 2026-06-30: Final validation passed: `npm test` (90 tests), `npm run build`, full `npm run release:check`, explicit tgz/Windows zip content checks for `reindex-projects.mjs`, `node dist/index.js --version` returning `4.8.2`, and `node dist/index.js --doctor` in the real user environment with 9 ok / 1 expected web-port warning / 0 errors.
