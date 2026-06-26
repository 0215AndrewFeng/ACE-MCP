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
