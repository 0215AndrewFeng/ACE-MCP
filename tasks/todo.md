# Project Removal API

Author: feng.ling

## Goal

Add an official Web API to remove a registered project and its indexed data, then use it to clean missing-path data-health warnings without direct SQLite edits.

## Plan

- [x] Inspect existing Web delete-project behavior and clear_project_index scope.
- [x] Add storage-level project deletion and Web API route.
- [x] Update the Web delete button to call the API before local list cleanup.
- [x] Add focused tests for API behavior and front-end contract.
- [x] Run validation, restart the local service, and remove the three missing registered projects.

## Validation Plan

- Focused Web route tests: `node --import tsx --test src/web/app.test.ts`.
- Static package/front-end contract: `node --import tsx --test src/config/packageManifest.test.ts`.
- TypeScript build: `npm run build`.
- Runtime cleanup check: `/health` no longer reports the three `PROJECT_PATH_MISSING` entries.

## Comments

- 2026-07-10: Existing `clear_project_index` clears files/chunks/vectors but leaves the project row, so it cannot resolve `/health` missing-path warnings. Existing Web delete button only removes LocalStorage entries.
- 2026-07-10: Added `DELETE /api/projects`, rebuilt and restarted LaunchAgent service, then removed the three missing registered projects. `/health` now reports `dataHealth.status=ok` and project total decreased from 29 to 26.

# v4.9.11 Runtime Data Health

Author: feng.ling

## Goal

Add lightweight runtime data-health diagnostics so ace-mcp can expose degraded but repairable states without making the service look simply "ok" or forcing users to inspect logs. Focus on safe diagnostics only: registered project path existence, health fallback when project listing fails, and project-profile degraded status when stats/vector/file reads fail.

## Plan

- [x] Add ROADMAP entries for deferred Web recent history/draft recovery and v4.9.11 runtime data health.
- [x] Write failing Web route tests for `/health` `dataHealth`, missing registered project paths, list-project fallback, and project-profile repairable degradation.
- [x] Implement shared runtime data-health helpers and wire them into `/health` and `/api/project-profile`.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, macOS installer, and release checklist to v4.9.11.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- RED/GREEN focused Web route test: `node --import tsx --test src/web/app.test.ts`.
- Static/package contract test: `node --import tsx --test src/config/packageManifest.test.ts`.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Runtime checks: `node dist/index.js --version`, `node dist/index.js --doctor`, `bash -n scripts/install-macos.sh`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.11 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.11 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.11` after LaunchAgent restart.

## Comments

- 2026-07-03: Started v4.9.11 after user approved application-level runtime self-healing/diagnostics and rejected low-value custom template features. Scope is data-health observability and repair guidance; no index/search ranking/MCP contract changes planned.
- 2026-07-03: RED confirmed `/health` lacked `dataHealth`, project-list failure returned only a minimal fallback, and project-profile stats failure returned 500. GREEN added shared `dataHealth` helpers, health/project-profile degraded and repairable reports, Web-visible data-health status/suggestions, v4.9.11 docs/version updates, and ROADMAP entry for deferred recent history/draft recovery. Focused Web route tests passed with 19 tests, package/static contract tests passed with 29 tests, `npm test` passed with 125 tests, `npm run build` passed, `node dist/index.js --version` returned `4.9.11`, `node dist/index.js --doctor` reported 9 ok, 1 expected Web port warning, 0 error, and `bash -n scripts/install-macos.sh` passed.
- 2026-07-03: Release handoff complete: `zsh -ic 'npm run release:check'` passed including tgz/Windows zip generation, secret scan, smoke, and benchmark; package content checks confirmed required Web/static/install/release/data-health artifacts in `ace-mcp-4.9.11.tgz` and `release/ace-mcp-v4.9.11-win-x64.zip`; exact token literal scan returned no project-file matches. Committed `bb25a98`, tagged and pushed `v4.9.11`, pushed `master`, published Gitee Release `v4.9.11` (#732524), uploaded `ace-mcp-4.9.11.tgz` and `ace-mcp-v4.9.11-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.11` on pid `65391` with `dataHealth.status=repairable` due to 3 missing registered project paths.

# v4.9.10 Web Query Task Templates

Author: feng.ling

## Goal

Add lightweight Web templates that fill the search or QA input with common code-reading tasks, reducing repeated prompt typing after users find and package code context, without changing backend APIs, indexing, search ranking, or LLM request semantics.

## Plan

- [x] Write failing package/static and VM behavior contracts for v4.9.10 docs/version references, search template controls, QA task template controls, and input-fill behavior.
- [x] Add compact template button groups below Web search and QA inputs with common tasks: call chain, impact analysis, bug scan, test generation, and business flow summary.
- [x] Implement reusable front-end helpers to render templates, apply template text to the correct textarea, focus the input, and keep Enter/send behavior unchanged.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, macOS installer, and release checklist to v4.9.10.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- RED/GREEN focused package contract test: `node --import tsx --test src/config/packageManifest.test.ts`.
- Static and VM contracts prove templates render for both search and QA inputs and clicking a template fills only the intended textarea.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Runtime checks: `node dist/index.js --version`, `node dist/index.js --doctor`, `bash -n scripts/install-macos.sh`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.10 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.10 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.10` after LaunchAgent restart.

## Comments

- 2026-07-03: Started v4.9.10 after user approved Web query/task templates. Scope is front-end input ergonomics only; no backend, indexing, ranking, or MCP API changes planned.
- 2026-07-03: RED confirmed missing v4.9.10 version contracts and missing Web query/task template containers, helpers, CSS, docs, and click-fill behavior. GREEN added `QUERY_TASK_TEMPLATES`, QA/search template panels, render/apply/bind/mount helpers, compact CSS, and v4.9.10 docs/version updates; focused package contract test passed with 28 tests.
- 2026-07-03: Pre-release validation passed after tightening the VM fake DOM test type: `npm test` passed with 121 tests, `npm run build` passed, `node dist/index.js --version` returned `4.9.10`, `node dist/index.js --doctor` reported 9 ok, 1 expected Web port warning, 0 error, `bash -n scripts/install-macos.sh` passed, `node --check src/web/static/js/app.js` passed, `git diff --check` passed, and `zsh -ic 'npm run release:check'` passed including tgz/Windows zip generation, secret scan, smoke, and benchmark. Package content checks confirmed required Web/static/install/release artifacts in `ace-mcp-4.9.10.tgz` and `release/ace-mcp-v4.9.10-win-x64.zip`; exact token literal scan returned no project-file matches.
- 2026-07-03: Release handoff complete: committed `b042d73`, tagged and pushed `v4.9.10`, pushed `master`, published Gitee Release `v4.9.10` (#732242), uploaded `ace-mcp-4.9.10.tgz` and `ace-mcp-v4.9.10-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.10` on pid `56187`.

# v4.9.9 Editable Context Bundle Task Draft

Author: feng.ling

## Goal

Let Web users add or choose a lightweight task instruction before copying a selected context bundle, so Codex/Claude handoff includes both multi-file evidence and the intended work, without changing backend APIs, indexing, or search ranking.

## Plan

- [x] Write failing package/static contracts for v4.9.9 docs/version references, context bundle task textarea, preset buttons, task instruction Markdown output, and Codex/Claude reuse of the same task draft.
- [x] Implement Web helpers to read task draft text, apply preset task instructions, and inject task intent into context bundle Markdown above selected source details.
- [x] Add compact task draft controls to search result and QA context bundle toolbars while preserving existing bundle copy buttons and single-result actions.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, macOS installer, and release checklist to v4.9.9.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- RED/GREEN focused package contract test: `node --import tsx --test src/config/packageManifest.test.ts`.
- Static and VM contracts prove preset controls render, task draft text is inserted near the top of Markdown, and Codex/Claude bundle buttons reuse the same draft.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Runtime checks: `node dist/index.js --version`, `node dist/index.js --doctor`, `bash -n scripts/install-macos.sh`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.9 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.9 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.9` after LaunchAgent restart.

## Comments

- 2026-07-02: Started v4.9.9 after user approved editable task draft for context bundles. Scope is Web UI prompt quality over existing selected result bundle data; no backend, indexing, ranking, or MCP API change planned.
- 2026-07-02: RED confirmed missing v4.9.9 version contracts plus missing task draft constants, textarea/preset controls, and Markdown task instruction output. GREEN added `CONTEXT_BUNDLE_TASK_PRESETS`, task draft read/apply helpers, compact toolbar textarea/presets, Markdown `任务说明` injection for copy/Codex/Claude actions, CSS styling, and v4.9.9 docs/version updates; focused package contract test passed with 25 tests.
- 2026-07-02: Review tightened the release: replaced broad package-content `rg` examples with per-artifact `rg -Fx` checks, added a behavior-level DOM/event contract proving preset click is reused by copy/Codex/Claude bundle actions, and updated `tasks/lessons.md`. Focused package contract test passed with 26 tests, full `npm test` passed with 119 tests, `npm run build` passed, `node dist/index.js --version` returned `4.9.9`, `node dist/index.js --doctor` reported 9 ok, 1 expected Web port warning, 0 error, `bash -n scripts/install-macos.sh` passed, and `zsh -ic 'npm run release:check'` passed including tgz/Windows zip generation, secret scan, smoke, and benchmark. Package content checks confirmed every required artifact individually in `ace-mcp-4.9.9.tgz` and `release/ace-mcp-v4.9.9-win-x64.zip`; exact token literal scan returned no project-file matches.
- 2026-07-02: Release handoff complete: committed `6aee22a`, tagged and pushed `v4.9.9`, pushed `master`, published Gitee Release `v4.9.9` (#731739), uploaded `ace-mcp-4.9.9.tgz` and `ace-mcp-v4.9.9-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.9` on pid `62802`.

# v4.9.8 Result Context Bundle

Author: feng.ling

## Goal

Let Web users select multiple search results or QA source cards and copy a single Markdown context bundle for Codex/Claude follow-up, without changing indexing, search ranking, result payloads, or backend APIs.

## Plan

- [x] Write failing package/static contracts for v4.9.8 docs/version references, source selection controls, context bundle toolbar, Markdown bundle generation, Codex/Claude bundle prompts, and no backend API changes.
- [x] Implement Web helpers to normalize selected sources, format multi-file Markdown bundles, and preserve absolute paths, `path:line` references, snippets, and match explanations.
- [x] Add selection checkboxes and copy bundle controls to search result explanation rows and QA source cards while preserving existing single-result actions and lazy context preview.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, macOS installer, and release checklist to v4.9.8.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- RED/GREEN focused package contract test: `node --import tsx --test src/config/packageManifest.test.ts`.
- Static and VM contracts prove selected result bundles include project root, absolute paths, references, snippets, match reasons, and agent-specific wording for Codex/Claude.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Runtime checks: `node dist/index.js --version`, `node dist/index.js --doctor`, `bash -n scripts/install-macos.sh`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.8 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.8 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.8` after LaunchAgent restart.

## Comments

- 2026-07-02: Started v4.9.8 after user approved multi-result context bundle direction. Scope is Web UI packaging of already-rendered search/QA result data; no search backend, indexing, ranking, or MCP API changes planned.
- 2026-07-02: RED confirmed missing v4.9.8 version contracts and selected context bundle helpers. GREEN added source bundle selectors, search/QA context bundle toolbars, Markdown bundle generation for Codex/Claude, DOM-based selected-source collection, compact CSS, and v4.9.8 docs/version updates; focused package contract test passed with 24 tests.
- 2026-07-02: Full local validation passed before release commit: `npm test` passed with 117 tests, `npm run build` passed, `node dist/index.js --version` returned `4.9.8`, `node dist/index.js --doctor` reported 9 ok, 1 expected Web port warning, 0 error, `bash -n scripts/install-macos.sh` passed, and `zsh -ic 'npm run release:check'` passed including tgz/Windows zip generation, secret scan, smoke, and benchmark. Package content checks confirmed Web JS/CSS and release scripts are included in `ace-mcp-4.9.8.tgz` and `release/ace-mcp-v4.9.8-win-x64.zip`; exact token literal scan returned no project-file matches.
- 2026-07-02: Release handoff complete: committed `85415b9`, tagged and pushed `v4.9.8`, pushed `master`, published Gitee Release `v4.9.8` (#731700), uploaded `ace-mcp-4.9.8.tgz` and `ace-mcp-v4.9.8-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.8` on pid `29653`.

# v4.9.7 IDE / Agent Jump Actions

Author: feng.ling

## Goal

Close the Web result-location loop by adding direct jump/copy actions for IDEs and agent handoff prompts on search result explanations and QA source cards, without changing indexing, search ranking, or backend API contracts.

## Plan

- [x] Write failing package/static contracts for v4.9.7 docs/version references, absolute path formatting, VS Code and IDEA deep links, Codex/Claude prompt actions, and no Cursor action.
- [x] Implement reusable Web helpers for source absolute paths, IDE deep links, and agent handoff prompts using the selected project root plus result file/line/snippet data.
- [x] Add the new actions to search result explanation rows and QA source cards while preserving existing copy path/reference/snippet controls and lazy context preview.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, macOS installer, and release checklist to v4.9.7.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- RED/GREEN focused package contract test: `node --import tsx --test src/config/packageManifest.test.ts`.
- Static and VM contracts prove absolute path, VS Code link, IDEA link, copied Codex prompt, copied Claude prompt, and no Cursor action.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Runtime checks: `node dist/index.js --version`, `node dist/index.js --doctor`, `bash -n scripts/install-macos.sh`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.7 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.7 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.7` after LaunchAgent restart.

## Comments

- 2026-07-02: Started v4.9.7 after user approved keeping VS Code, adding IDEA, adding absolute-path copy, and adding Codex/Claude handoff as copied prompts. Cursor is intentionally out of scope.
- 2026-07-02: RED confirmed missing IDE/Agent action helpers and v4.9.7 version contracts. GREEN added absolute-path formatting, VS Code/IDEA deep links, Codex/Claude prompt copy actions, shared binding for search summaries and QA source cards, CSS styling, and v4.9.7 docs/version updates; focused package contract test passed with 22 tests.
- 2026-07-02: Full local validation passed before release commit: `npm test` passed with 115 tests, `npm run build` passed, `node dist/index.js --version` returned `4.9.7`, `node dist/index.js --doctor` reported 9 ok, 1 expected Web port warning, 0 error, `bash -n scripts/install-macos.sh` passed, and `zsh -ic 'npm run release:check'` passed including tgz/Windows zip generation, secret scan, smoke, and benchmark. Package content checks confirmed Web JS/CSS and release scripts are included in `ace-mcp-4.9.7.tgz` and `release/ace-mcp-v4.9.7-win-x64.zip`; exact token literal scan returned no project-file matches.
- 2026-07-02: Release handoff complete: committed `02078a6`, tagged and pushed `v4.9.7`, pushed `master`, published Gitee Release `v4.9.7` (#731683), uploaded `ace-mcp-4.9.7.tgz` and `ace-mcp-v4.9.7-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.7` on pid `42805`.

# v4.9.6 Lazy Context Preview

Author: feng.ling

## Goal

Let Web search result explanations and QA source cards load a wider code context on demand, so users can inspect surrounding code directly without changing search ranking, indexing, or default response payload size.

## Plan

- [x] Write failing package/static contracts for v4.9.6 docs/version references, lazy context preview controls, `/api/file-snippet` payload wiring, metadata-mode compatibility, and CSS states.
- [x] Add reusable Web helpers to derive preview ranges from `filePath/startLine/endLine`, render a "more context" action, request `/api/file-snippet` only after click, and render highlighted line-numbered context.
- [x] Add lazy context preview actions to search result explanation rows and QA source cards while preserving existing copy actions, raw JSON output, and QA snippet expand/collapse behavior.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, release checklist, macOS installer, and package docs to v4.9.6.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- Static and VM contract tests prove lazy context buttons are rendered for search/QA sources, preserve metadata-mode path-only behavior, call `/api/file-snippet` with expanded line ranges, and render returned snippets without preloading them.
- Focused package contract test: `node --import tsx --test src/config/packageManifest.test.ts`.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.6 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.6 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.6` after LaunchAgent restart.

## Comments

- 2026-07-02: Started v4.9.6 after user approved lazy context preview. Scope is Web UI inspection over existing `/api/file-snippet`; no search backend, ranking, indexing, or MCP API contract change planned.
- 2026-07-02: RED confirmed missing v4.9.6 docs/version references and lazy context preview contracts. GREEN added range derivation, "更多上下文" actions, click-only `/api/file-snippet` loading, line-numbered highlighted preview rendering, CSS states, metadata-mode coverage, and v4.9.6 docs/version updates; focused package contract test passed with 20 tests.
- 2026-07-02: Review found preview headers should use server-clamped snippet end lines instead of deriving from split line count. RED added a contract for `response.meta.snippet.endLine`; GREEN updated preview rendering to display returned start/end range, and the focused package contract test passed with 20 tests.
- 2026-07-02: Full local validation passed before release commit: `npm test` passed with 113 tests, `npm run build` passed, `node dist/index.js --version` returned `4.9.6`, `node dist/index.js --doctor` reported 9 ok, 1 expected Web port warning, 0 error, `bash -n scripts/install-macos.sh` passed, and `zsh -ic 'npm run release:check'` passed including tgz/Windows zip generation, secret scan, smoke, and benchmark. Package content checks confirmed Web JS/CSS and release scripts are included in `ace-mcp-4.9.6.tgz` and `release/ace-mcp-v4.9.6-win-x64.zip`; exact token literal scan returned no project-file matches.
- 2026-07-02: Release handoff complete: committed `753b226`, tagged and pushed `v4.9.6`, pushed `master`, published Gitee Release `v4.9.6` (#731613), uploaded `ace-mcp-4.9.6.tgz` and `ace-mcp-v4.9.6-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.6` on pid `30479`.

# v4.9.5 Search Result Actions

Author: feng.ling

## Goal

Make Web search and QA source results directly actionable by adding copy controls for file paths, `path:line` references, and snippets, plus compact controls to expand or collapse all match explanations.

## Plan

- [x] Write failing static package contract tests for result action rendering, copy handlers, explanation expand/collapse controls, metadata-mode path copy support, and v4.9.5 docs/version references.
- [x] Implement reusable Web helpers for source reference formatting, snippet extraction, copy button rendering, and action binding without changing search result ordering or backend APIs.
- [x] Add action buttons to search result explanation rows and QA source cards: copy file path, copy `path:startLine`, and copy snippet when available.
- [x] Add search summary controls to expand or collapse all match explanation chips while keeping raw JSON output unchanged.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, release checklist, macOS installer, and package docs to v4.9.5.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- Static contract tests prove Web result cards expose copy controls, bind copy handlers, keep metadata-mode path copy available without snippets, and include v4.9.5 docs/version references.
- Focused package contract test: `node --import tsx --test src/config/packageManifest.test.ts`.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.5 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.5 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.5` after LaunchAgent restart.

## Comments

- 2026-07-02: Started v4.9.5 after user approved search-result action controls. Scope is Web UI ergonomics over existing search/QA result data; no search backend, scoring, indexing, or API contract change planned.
- 2026-07-02: RED confirmed missing v4.9.5 docs/version references and Web result action contracts. GREEN added copy path/reference/snippet controls, search explanation expand/collapse binding, metadata-mode path/reference action coverage, CSS styling, and v4.9.5 docs/version updates; focused package contract test passed with 19 tests.
- 2026-07-02: Review caught duplicate click-listener risk when QA source cards remain mounted across summary refreshes. RED added an idempotent binding contract for search result actions; GREEN stores `dataset.searchActionBound` before attaching the listener, and the focused package contract test passed with 19 tests.
- 2026-07-02: Subagent review found copy-snippet values trimmed leading/trailing whitespace and noted missing version-sync assertions. RED added a VM render assertion for snippet whitespace preservation plus package-lock/`APP_VERSION` version checks; GREEN split snippet presence detection from copied snippet text, and the focused package contract test passed with 19 tests.
- 2026-07-02: Full local validation passed before release commit: `npm test` passed with 112 tests, `npm run build` passed, `node dist/index.js --version` returned `4.9.5`, `node dist/index.js --doctor` reported 9 ok, 1 expected Web port warning, 0 error, `bash -n scripts/install-macos.sh` passed, and `zsh -ic 'npm run release:check'` passed including tgz/Windows zip generation, secret scan, smoke, and benchmark. Package content checks confirmed Web JS/CSS and release scripts are included in `ace-mcp-4.9.5.tgz` and `release/ace-mcp-v4.9.5-win-x64.zip`; exact token literal scan returned no project-file matches.
- 2026-07-02: Release handoff complete: committed `e7d0db0`, tagged and pushed `v4.9.5`, pushed `master`, published Gitee Release `v4.9.5` (#731525), uploaded `ace-mcp-4.9.5.tgz` and `ace-mcp-v4.9.5-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.5` on pid `11253`.

# v4.9.4 Search Result Match Explanation

Author: feng.ling

## Goal

Make Web search results explain why they matched by surfacing existing result reason/explanation metadata in compact, readable UI without changing search ranking or indexing behavior.

## Plan

- [x] Write failing static package contract tests for Web search match explanation rendering, explanation chips, metadata-mode support, CSS styling, and v4.9.4 docs/version references.
- [x] Implement Web rendering helpers that turn result `reason`, `score`, and `explanation` fields into concise "why matched" labels.
- [x] Show explanation details on search/source result cards while preserving raw JSON output and existing result ordering.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, release checklist, macOS installer, and package docs to v4.9.4.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- Static contract tests prove Web source cards render match explanations from `reason`, `score`, and `explanation` metadata, including metadata-mode responses.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.4 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.4 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.4` after LaunchAgent restart.

## Comments

- 2026-07-02: Started v4.9.4 after user approved search result match explanations. Scope is Web visibility over existing search result metadata; no scoring or ranking changes planned.
- 2026-07-02: RED confirmed missing v4.9.4 docs/version references and Web match-explanation contracts. GREEN added search match explanation helpers, summary/source-card rendering, CSS styling, v4.9.4 docs/version updates, and focused package contract test passed with 17 tests.
- 2026-07-02: Review found `title` attribute escaping risk in the match explanation tooltip. Added a focused VM render test for quote-bearing tokens and reason fallback, introduced `escapeHtmlAttribute`, and reran focused package contract tests with 18 passing tests.
- 2026-07-02: Full local validation passed before release commit: `npm test` passed with 111 tests, `npm run build` passed, `zsh -ic 'npm run release:check'` passed including tgz/Windows zip generation, secret scan, smoke, and benchmark; `node dist/index.js --version` returned `4.9.4`; `node dist/index.js --doctor` reported 9 ok, 1 expected Web port warning, 0 error; package content checks confirmed Web JS/CSS and release scripts are included in tgz and Windows zip.
- 2026-07-02: Release handoff complete: committed `96dbf0e`, tagged and pushed `v4.9.4`, pushed `master`, published Gitee Release `v4.9.4` (#731386), uploaded `ace-mcp-4.9.4.tgz` and `ace-mcp-v4.9.4-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.4` on pid `70043`.

# v4.9.3 Profile Repair Result Visibility

Author: feng.ling

## Goal

Complete the Web project profile loop by making one-click repair outcomes visible, showing before/after profile deltas, and turning failed-file review into a readable detail panel with copyable paths.

## Plan

- [x] Write failing static package contract tests for repair result rendering, before/after comparison, failed-file details, copy path actions, and v4.9.3 docs/version references.
- [x] Implement Web repair result summary after project profile fix actions, including task status, duration, and profile count/vector/summary changes.
- [x] Render failed-file review as a compact detail panel with file paths, errors, and copy buttons while preserving raw JSON output.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, release checklist, macOS installer, and package docs to v4.9.3.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- Static contract tests prove Web profile repair actions render a result panel, compare before/after profile fields, show failed files, and expose copy path actions.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.3 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.3 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.3` after LaunchAgent restart.

## Comments

- 2026-07-02: Started v4.9.3 after user approved profile repair result visibility. Scope is Web outcome visibility on top of existing v4.9.2 repair dispatch; no index core changes planned.
- 2026-07-02: RED confirmed missing v4.9.3 docs/version references and Web repair-result contracts. GREEN added profile summary diffing, repair result rendering, failed-file detail rendering, copy-path actions, CSS styling, and v4.9.3 docs/version updates; focused package contract test passed with 16 tests.
- 2026-07-02: Local validation passed: full `npm test` passed with 109 tests, `npm run build` passed, `zsh -ic 'npm run release:check'` passed including tgz/Windows zip generation, secret scan, smoke, and benchmark; `node dist/index.js --version` returned `4.9.3`; `node dist/index.js --doctor` reported 9 ok, 1 expected Web port warning, 0 error; package content checks confirmed Web JS/CSS and release scripts are included in tgz and Windows zip.
- 2026-07-02: Release handoff complete: committed `c9a5066`, tagged and pushed `v4.9.3`, pushed `master`, published Gitee Release `v4.9.3` (#731297), uploaded `ace-mcp-4.9.3.tgz` and `ace-mcp-v4.9.3-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.3` on pid `19340`.

# v4.9.2 Project Profile One-Click Fixes

Author: feng.ling

## Goal

Close the Web diagnostics loop by turning project profile suggestions into one-click actions that submit the matching repair work, refresh task visibility, and reload the profile after the repair completes.

## Plan

- [x] Write failing static package contract tests for project profile suggestion action buttons, fix dispatcher, task polling, profile refresh, and v4.9.2 docs/version references.
- [x] Implement Web suggestion actions for full index, summary generation, vector warmup, and failed-file review using existing `/api/index-project`, `/api/summary/generate`, `/api/index/warm`, task polling, and profile reload.
- [x] Keep unsupported/manual diagnostics visible without breaking raw JSON output.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, release checklist, and package docs to v4.9.2.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- Static contract tests prove the Web profile suggestions render actionable controls and wire `RUN_FULL_INDEX`, `GENERATE_SUMMARY`, `WARM_VECTOR_INDEX`, and `REVIEW_FAILED_FILES`.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.2 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.2 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.2` after LaunchAgent restart.

## Comments

- 2026-07-02: Started v4.9.2 after user approved one-click project profile repair. Scope is front-end repair orchestration on top of existing index, summary, warm, task, and profile APIs.
- 2026-07-02: RED confirmed missing one-click Web profile actions and v4.9.2 docs/version references. GREEN added profile suggestion buttons, repair dispatch for full index/summary/vector warmup/failed-file review, task polling, task-center refresh, profile reload, and docs/version updates. Focused package contract tests passed with 15 tests, full `npm test` passed with 108 tests, `npm run build` passed, and `zsh -ic 'npm run release:check'` passed including secret scan, smoke, benchmark, tgz, and Windows zip generation.
- 2026-07-02: Release handoff complete: committed `4ee745e`, tagged and pushed `v4.9.2`, pushed `master`, published Gitee Release `v4.9.2` (#731242), uploaded `ace-mcp-4.9.2.tgz` and `ace-mcp-v4.9.2-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.2` on pid `60330`.

# v4.9.1 Project Search Profile Diagnostics

Author: feng.ling

## Goal

Add a project-level search profile and recall diagnostics panel so users can quickly see whether a project is indexed, summarized, vector-ready, and likely to return useful search results.

## Plan

- [x] Write failing Web route and static package contract tests for `/api/project-profile`, profile diagnostics fields, Web controls, and v4.9.1 references.
- [x] Implement a lightweight project profile API that reads project stats, summary metadata, vector coverage, language distribution, and deterministic diagnostic suggestions without slowing `/health`.
- [x] Add a compact Web profile panel for counts, languages, vector coverage, summary status, latest index metadata, and actionable suggestions.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, release checklist, and package docs to v4.9.1.
- [x] Run focused tests, full validation, release packaging, commit/tag/push, publish Gitee Release, verify assets, restart local service, and record handoff.

## Validation Plan

- Focused Web/API tests: `/api/project-profile` validates `projectRootPath`, returns indexed profile details, and reports missing index/summary/vector/symbol diagnostics.
- Static package contract tests prove v4.9.1 docs/version references and Web UI/API wiring.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `zsh -ic 'npm run release:check'`.
- Post-tag release publishing: `zsh -ic 'npm run release:publish -- --version 4.9.1 --timeout-ms 20000'`.
- Asset verification: `npm run release:verify-assets -- --version 4.9.1 --timeout-ms 20000`.
- Local service handoff: `/health` reports version `4.9.1` after LaunchAgent restart.

## Comments

- 2026-07-02: Started v4.9.1 after user approved project-level search profile diagnostics. Scope is a detail endpoint and Web visibility; `/health` must remain free of per-project aggregate reads.
- 2026-07-02: RED confirmed missing `/api/project-profile`, Web search profile controls, and v4.9.1 docs/version references. GREEN added the profile API, Web summary cards/suggestions, docs/version updates, and focused Web/static tests passed with 30 tests.
- 2026-07-02: Release handoff complete: full `npm test` passed with 107 tests, `npm run build` passed, `zsh -ic 'npm run release:check'` passed including tgz/Windows zip generation, secret scan, smoke, and benchmark; committed `ea14734`, tagged and pushed `v4.9.1`, pushed `master`, published Gitee Release `v4.9.1` (#731102), verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.9.1` on pid `70703`.

# v4.8.10 Release Secret Guard

Author: feng.ling

## Goal

Prevent Gitee token leakage by adding a repeatable release secret scanner that checks workspace files, packaged artifacts, and git history without printing secret values.

## Plan

- [x] Write failing package/README contract tests for `scripts/check-secrets.mjs`, `npm run security:secrets`, release checklist integration, and v4.8.10 docs/version references.
- [x] Implement `scripts/check-secrets.mjs` with exact env-secret scans for project files, tgz/zip artifacts, and git history while redacting values from output.
- [x] Wire `security:secrets` into `release:check` and Windows packaging.
- [x] Update README release docs, CHANGELOG, ROADMAP, release checklist, Windows README references, version files, and task lessons to v4.8.10.
- [x] Run focused RED/GREEN tests, full validation, and record local handoff without pushing remote branches.

## Validation Plan

- Focused contract test: `npm test -- src/config/packageManifest.test.ts`.
- Script help/static execution: `node scripts/check-secrets.mjs --help`.
- Real local secret scan: `npm run security:secrets`.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.
- Local service handoff only if release is installed locally; no remote branch push for this task.

## Comments

- 2026-07-01: Started v4.8.10 after user approved release secret guard. Scope is local release safety and documentation; no remote branch push should be performed.
- 2026-07-01: RED confirmed missing secret guard: package version/script, `scripts/check-secrets.mjs`, release checklist secret gate, Windows packaging, and v4.8.10 docs failed before implementation. GREEN added the redacted scanner, package wiring, Windows package inclusion, docs/version updates, and focused package contract test passed with 103 tests.
- 2026-07-01: Local validation passed without remote push: `node scripts/check-secrets.mjs --help`, `zsh -ic 'npm run security:secrets'` with `GITEE_TOKEN=redacted`, focused package contract test, full `npm test` inside `release:check` (103 tests), `npm run build`, full `zsh -ic 'npm run release:check'`, `node dist/index.js --version` returning `4.8.10`, doctor with only the expected Web port in-use warning, tgz and Windows zip containing `check-secrets.mjs`, and exact scan confirmed the provided token literal is absent from project files.
- 2026-07-01: Release handoff complete after user approved pushing: committed `3684698`, tagged and pushed `v4.8.10`, pushed `master`, published via `zsh -ic 'npm run release:publish -- --version 4.8.10 --timeout-ms 20000'` using `GITEE_TOKEN=redacted`, created Gitee Release `v4.8.10` (#730523), uploaded `ace-mcp-4.8.10.tgz` and `ace-mcp-v4.8.10-win-x64.zip`, verified release assets 4/4 HTTP 200, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.8.10` on pid `72821`.

# v4.8.9 Gitee Release Publish Automation

Author: feng.ling

## Goal

Automate Gitee Release creation/update and artifact upload so release handoff can run from a single script after tag push, followed by asset verification.

## Plan

- [x] Review v4.8.8 release verifier, release checklist, Gitee Release page workflow, and Gitee OpenAPI release/attach file endpoints.
- [x] Write failing package/README contract tests for `scripts/publish-gitee-release.mjs` and `npm run release:publish`.
- [x] Implement `scripts/publish-gitee-release.mjs` using Gitee OpenAPI: version/tag/commit/artifact checks, create or update Release, replace/upload tgz and Windows zip attachments, then run asset verification.
- [x] Update README release docs, CHANGELOG, ROADMAP, release checklist, Windows README references, version files, and package scripts to v4.8.9.
- [x] Run focused RED/GREEN tests, full validation, publish via `npm run release:publish -- --version 4.8.9`, replace local service, and record handoff.

## Validation Plan

- Focused contract test: `npm test -- src/config/packageManifest.test.ts`.
- Publish script static execution: `node scripts/publish-gitee-release.mjs --help`.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.
- Post-tag publish: `npm run release:publish -- --version 4.8.9`.
- Local service handoff: `/health` reports version `4.8.9` after LaunchAgent restart.

## Comments

- 2026-07-01: Started v4.8.9 after user approved Gitee Release automation. Gitee Swagger confirms release endpoints: create/update releases and upload/delete attach files are available under `/api/v5/repos/{owner}/{repo}/releases`.
- 2026-07-01: RED confirmed missing publish automation: package version/script, publish script, README/checklist commands, and v4.8.9 asset references failed before implementation. GREEN added token-based Gitee OpenAPI publish script, Windows package inclusion, v4.8.9 docs/version updates, and focused contract test passed with 102 tests.
- 2026-07-01: Local validation passed: `node scripts/publish-gitee-release.mjs --help`, `bash -n scripts/install-macos.sh`, focused package contract test, full `npm test` (102 tests), `npm run build`, full `npm run release:check`, `node dist/index.js --version` returning `4.8.9`, doctor with only the expected Web port in-use warning, tgz containing publish/verifier/installer scripts, and Windows zip containing `publish-gitee-release.mjs`.
- 2026-07-01: Release handoff complete: committed `8f11677`, tagged and pushed `v4.8.9`, pushed `master`, attempted `npm run release:publish -- --version 4.8.9 --timeout-ms 20000` and confirmed it fails safely without `GITEE_TOKEN` after tag/artifact preflight; used the Gitee Release page fallback to create Release `v4.8.9` with attachments `ace-mcp-4.8.9.tgz` and `ace-mcp-v4.8.9-win-x64.zip`; verified `npm run release:verify-assets -- --version 4.8.9 --timeout-ms 20000` returned 4/4 HTTP 200 checks; restarted LaunchAgent `com.ace-mcp.server`; and verified `http://127.0.0.1:8787/health` reports version `4.8.9` on pid `71674`.

# v4.8.8 Install Release Closure

Author: feng.ling

## Goal

Close the one-command install release loop by pinning macOS installer docs to version tags and adding a repeatable release asset verifier for Gitee tgz/Windows downloads.

## Plan

- [x] Review v4.8.7 macOS installer, release smoke, release checklist, and prior release lessons.
- [x] Write failing package/README contract tests for tag-pinned installer docs and release asset URL verification tooling.
- [x] Add `scripts/verify-release-assets.mjs` to check tag, tgz, Windows zip, and optional installer script URLs with configurable base URL and timeouts.
- [x] Update README install commands to tag-pinned script URLs and document release asset verification.
- [x] Update package scripts, CHANGELOG, ROADMAP, release checklist, Windows README references, version files, and task lessons if needed to v4.8.8.
- [x] Run focused RED/GREEN tests and full local validation.
- [x] Run network asset verification after tag push, replace local service, and record handoff.

## Validation Plan

- Focused contract test: `npm test -- src/config/packageManifest.test.ts`.
- Script syntax/static execution: `node scripts/verify-release-assets.mjs --help`.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.
- Post-tag network verification: `npm run release:verify-assets -- --version 4.8.8`.
- Local service handoff: `/health` reports version `4.8.8` after LaunchAgent restart.

## Comments

- 2026-07-01: Started v4.8.8 after user approved install release closure. Scope is release/install robustness, not runtime MCP behavior.
- 2026-07-01: RED confirmed release/install contract gaps: README still used `raw/master`, `release:verify-assets` and verifier script were missing, and release docs still referenced v4.8.7. GREEN added the verifier, tag-pinned installer docs, package/Windows packaging coverage, and v4.8.8 version docs.
- 2026-07-01: Local verification passed: focused package contract RED/GREEN, `node scripts/verify-release-assets.mjs --help`, `bash -n scripts/install-macos.sh`, full `npm test` (101 tests), `npm run build`, full `npm run release:check`, `node dist/index.js --version` returning `4.8.8`, doctor with only the expected Web port in-use warning, tgz containing installer/verifier scripts, and Windows zip containing verifier script.
- 2026-07-01: Release handoff complete: committed `4ade428`, tagged and pushed `v4.8.8`, pushed `master`, created Gitee Release `v4.8.8`, uploaded `ace-mcp-4.8.8.tgz` and `ace-mcp-v4.8.8-win-x64.zip`, verified `npm run release:verify-assets -- --version 4.8.8 --timeout-ms 20000` returned 4/4 HTTP 200 checks, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.8.8` on pid `83217`.

# v4.8.7 macOS Quick Install

Author: feng.ling

## Goal

Add a beginner-friendly macOS command-line installer and README dependency checklist so users can install ace-mcp from Gitee Release with one copy-paste command.

## Plan

- [x] Review existing tgz/global install docs, packaging scripts, and package contract tests.
- [x] Write failing package/README contract tests for the macOS installer script and dependency checklist.
- [x] Implement `scripts/install-macos.sh` with Node/npm checks, optional Homebrew Node install, tgz download, global install, and doctor verification.
- [x] Update README, CHANGELOG, ROADMAP, release checklist, Windows README version references, and version strings to v4.8.7.
- [x] Run focused RED/GREEN tests and full validation.
- [x] Commit/tag/push, replace local service, and record handoff.

## Validation Plan

- Focused contract test: `npm test -- src/config/packageManifest.test.ts`.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.
- macOS installer static shell validation: `bash -n scripts/install-macos.sh`.
- Local service handoff: `/health` reports version `4.8.7` after LaunchAgent restart.

## Comments

- 2026-07-01: Started v4.8.7 after user requested a macOS command-line quick install and beginner dependency checklist. Scope is installer/docs/package contract; no runtime MCP behavior change expected.
- 2026-07-01: RED confirmed the package/README contract failed because `scripts/install-macos.sh` was missing. GREEN added the macOS installer, README one-command install and dependency checklist, release checklist script validation, and v4.8.7 docs/version updates.
- 2026-07-01: Verification passed: focused package contract RED/GREEN, `bash -n scripts/install-macos.sh`, full `npm test` (100 tests), `npm run build`, full `npm run release:check`, `node dist/index.js --version` returning `4.8.7`, doctor with only the expected Web port in-use warning, tgz containing `package/scripts/install-macos.sh`, and Windows zip smoke content check.
- 2026-07-01: Release handoff complete: committed `6b1d03c`, tagged and pushed `v4.8.7`, pushed `master`, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.8.7` on pid `70627`.

# v4.8.6 Task Dedupe and Cancel

Author: feng.ling

## Goal

Prevent duplicate long-running work and let users cancel active tasks from the API/Web task center, while formalizing local `.ace-mcp` / `.codex` ignores.

## Plan

- [x] Review v4.8.5 task tracker/routes/UI and the pre-existing `.gitignore` local change.
- [x] Write failing tests for duplicate task reuse and task cancel behavior before production changes.
- [x] Extend `LongTaskTracker` with task keys, duplicate active task reuse, `canceled` status, and cancel APIs.
- [x] Wire index/summary submissions to stable task keys and add `POST /api/tasks/:taskId/cancel`.
- [x] Add cancel controls to the Web task center and refresh task state after cancellation.
- [x] Update static/package contract tests for cancel UI/API, plus `.gitignore` expectations.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, and release checklist to v4.8.6.
- [x] Run full validation, commit/tag/push, replace local service, and record handoff.

## Validation Plan

- RED/GREEN focused Web route tests: duplicate index/summary submissions reuse one task id; cancel active task changes status to `canceled`; completed tasks cannot be canceled.
- Static contract tests prove task center exposes cancel controls and route wiring.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.
- Local service handoff: `/health` reports version `4.8.6` after LaunchAgent restart.

## Comments

- 2026-07-01: Started v4.8.6 after v4.8.5. Scope is best-effort in-memory de-dupe/cancel for active Web tasks; running work may not be preemptively aborted unless it cooperates, but canceled tasks must not be marked succeeded afterward.
- 2026-07-01: RED confirmed duplicate active index submissions created separate task ids and `/api/tasks/:id/cancel` was missing. GREEN implemented active task key reuse, `canceled` status, cancel endpoint, Web cancel button, and `.gitignore` release hygiene.
- 2026-07-01: Verification passed: focused Web route RED/GREEN, full `npm test` (99 tests), `npm run build`, full `npm run release:check`, `node dist/index.js --version` returning `4.8.6`, and doctor with only the expected Web port in-use warning.
- 2026-07-01: Release handoff complete: committed `07babaa`, tagged and pushed `v4.8.6`, pushed `master`, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.8.6` on pid `83475`.

# v4.8.5 Task Center UI

Author: feng.ling

## Goal

Make the async task system directly usable from the Web panel by adding task filters, task history, and compact result/error details for index and summary tasks.

## Plan

- [x] Review v4.8.4 task API, Web layout, static contract tests, and release lessons.
- [x] Add `/api/tasks` filters for `type`, `status`, and `projectRootPath` while keeping `/health.tasks` active-only.
- [x] Add focused Web route tests for task filtering and task detail behavior.
- [x] Build a compact Web task center with type/status/project filters, manual refresh, and expandable result/error details.
- [x] Update static/package contract tests for the new task center UI and polling paths.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, and release checklist to v4.8.5.
- [x] Run full validation.
- [x] Commit/tag/push, replace local service, and record handoff.

## Validation Plan

- Focused Web route tests: `/api/tasks` filters by type/status/project and `/api/tasks/:id` still returns full detail.
- Static package contract tests prove the task center HTML controls and JS rendering functions exist.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.
- Local service handoff: `/health` reports version `4.8.5` after LaunchAgent restart.

## Comments

- 2026-07-01: Started v4.8.5 after v4.8.4. Scope is UI/API visibility for existing in-memory task history; task persistence, de-dupe, and cancel remain future work.
- 2026-07-01: Implemented `/api/tasks` type/status/project filters, compact Web task center with filters/details, and v4.8.5 docs/version updates. Focused Web route run and `npm run build` passed before full release validation.
- 2026-07-01: Verification passed: full `npm test` (96 tests), `npm run build`, full `npm run release:check`, `node dist/index.js --version` returning `4.8.5`, and doctor with only the expected Web port in-use warning.
- 2026-07-01: Committed `4372426`, tagged `v4.8.5`, pushed `master` and tag to Gitee, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.8.5` on pid `75011`.

# v4.8.4 Async Index Tasks

Author: feng.ling

## Goal

Move Web full/incremental indexing into the unified long-task API so clients get a task id quickly, can poll index state/results, and summary/index maintenance flows share one task center.

## Plan

- [x] Review v4.8.3 task, index route, Web UI, and maintenance script behavior.
- [x] Extend task types and task listing filters for `index` and `summary`.
- [x] Make `POST /api/index-project` submit background index work and return `202 + taskId` while preserving parent-directory confirmation.
- [x] Update Web indexing button and maintenance script to poll `/api/tasks/:taskId`.
- [x] Add focused route tests for async index success/failure, missing project root, and parent-directory guard.
- [x] Update version strings, README, CHANGELOG, ROADMAP, Windows README, release checklist, and package contract tests to v4.8.4.
- [x] Run full validation.
- [x] Commit/tag/push, replace local service, and record handoff.

## Validation Plan

- Focused Web route tests: index submission returns quickly with task id, task result exposes index stats, failures are retained, and parent guard still returns 409 before task creation.
- Static/package contract tests proving Web and maintenance script poll `/api/tasks` for both summary and index work.
- Full unit/regression suite: `npm test`.
- TypeScript build: `npm run build`.
- Full release validation: `npm run release:check`.
- Local service handoff: `/health` reports version `4.8.4` after LaunchAgent restart.

## Comments

- 2026-06-30: Started v4.8.4 after v4.8.3. Scope is Web/API index task async submission plus shared task polling; SSE index progress remains synchronous stream behavior for now.
- 2026-06-30: Implemented index task async submission, Web/script task polling for index work, v4.8.4 docs/version updates, and focused Web route tests. Focused Web route run and `npm run build` passed before full release validation.
- 2026-06-30: Verification passed: full `npm test` (95 tests), `npm run build`, full `npm run release:check`, `node dist/index.js --version` returning `4.8.4`, and doctor with only the expected Web port in-use warning.
- 2026-06-30: Committed `9dbb69e`, tagged `v4.8.4`, pushed `master` and tag to Gitee, restarted LaunchAgent `com.ace-mcp.server`, and verified `http://127.0.0.1:8787/health` reports version `4.8.4` on pid `35753`.

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
