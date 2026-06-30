import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8")) as T;
}

interface PackageJson {
  bin: Record<string, string>;
  files: string[];
  private?: boolean;
  scripts: Record<string, string>;
  version: string;
}

test("package manifest is ready for npm and tgz global installation", () => {
  const pkg = readJson<PackageJson>("package.json");

  assert.equal(pkg.version, "4.8.2");
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.bin["ace-mcp"], "dist/index.js");
  assert.equal(pkg.bin["ace-mcp-web"], "scripts/start-web.mjs");
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("scripts"));
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.includes("CHANGELOG.md"));
  assert.ok(pkg.files.includes("!dist/**/*.test.*"));
  assert.ok(pkg.files.includes("!dist/test/**"));
  assert.equal(pkg.scripts["release:pack"], "npm run build && npm pack --cache .npm-cache");
  assert.equal(pkg.scripts["release:win"], "npm run build && node scripts/package-windows.mjs");
  assert.equal(pkg.scripts["release:smoke"], "node scripts/smoke-release.mjs");
  assert.equal(pkg.scripts["release:benchmark"], "node scripts/benchmark-search.mjs --smoke");
  assert.equal(pkg.scripts["release:check"], "npm test && npm run build && npm run release:pack && npm run release:win && npm run release:smoke && npm run release:benchmark");
  assert.equal(pkg.scripts["benchmark:search"], "node scripts/benchmark-search.mjs");
  assert.equal(pkg.scripts["maintenance:reindex"], "node scripts/reindex-projects.mjs");
  assert.match(pkg.scripts.test, /src\/adapters\/java\/index\.test\.ts/);
});

test("CLI bin entrypoint is directly executable after global npm install", () => {
  const entrypoint = readFileSync(path.join(rootDir, "src/index.ts"), "utf8");

  assert.equal(entrypoint.startsWith("#!/usr/bin/env node\n"), true);
});

test("global install helper scripts are packaged for Windows and cross-platform web startup", () => {
  const cmd = readFileSync(path.join(rootDir, "scripts/start-web.cmd"), "utf8");
  const ps1 = readFileSync(path.join(rootDir, "scripts/start-web.ps1"), "utf8");
  const mjs = readFileSync(path.join(rootDir, "scripts/start-web.mjs"), "utf8");

  assert.match(cmd, /dist\\index\.js/);
  assert.match(cmd, /--web-port/);
  assert.match(ps1, /dist[\\/]index\.js/);
  assert.match(ps1, /--web-port/);
  assert.match(mjs, /--web-port/);
  assert.match(mjs, /ACE_MCP_WEB_PORT/);
  assert.match(mjs, /SIGTERM/);
  assert.match(mjs, /SIGINT/);
  assert.match(mjs, /child\.kill/);
});

test("Windows zip release tooling is packaged with install scripts", () => {
  const packageScriptPath = path.join(rootDir, "scripts/package-windows.mjs");
  const smokeScriptPath = path.join(rootDir, "scripts/smoke-release.mjs");
  const benchmarkScriptPath = path.join(rootDir, "scripts/benchmark-search.mjs");
  const reindexScriptPath = path.join(rootDir, "scripts/reindex-projects.mjs");
  const cmdInstallPath = path.join(rootDir, "scripts/install-windows.cmd");
  const psInstallPath = path.join(rootDir, "scripts/install-windows.ps1");

  assert.equal(existsSync(packageScriptPath), true);
  assert.equal(existsSync(smokeScriptPath), true);
  assert.equal(existsSync(benchmarkScriptPath), true);
  assert.equal(existsSync(reindexScriptPath), true);
  assert.equal(existsSync(cmdInstallPath), true);
  assert.equal(existsSync(psInstallPath), true);

  const packageScript = readFileSync(packageScriptPath, "utf8");
  const smokeScript = readFileSync(smokeScriptPath, "utf8");
  const benchmarkScript = readFileSync(benchmarkScriptPath, "utf8");
  const reindexScript = readFileSync(reindexScriptPath, "utf8");
  const cmdInstall = readFileSync(cmdInstallPath, "utf8");
  const psInstall = readFileSync(psInstallPath, "utf8");

  assert.match(packageScript, /ace-mcp-v\$\{version\}-win-x64/);
  assert.match(packageScript, /\$\{packageName\}\.zip/);
  assert.match(packageScript, /README-WINDOWS\.md/);
  assert.match(packageScript, /install\.ps1/);
  assert.match(packageScript, /start-web\.cmd/);
  assert.match(packageScript, /scripts\/smoke-release\.mjs/);
  assert.match(packageScript, /scripts\/benchmark-search\.mjs/);
  assert.match(packageScript, /scripts\/reindex-projects\.mjs/);
  assert.match(smokeScript, /npm install/);
  assert.match(smokeScript, /ace-mcp --version/);
  assert.match(smokeScript, /ace-mcp-web/);
  assert.match(smokeScript, /\/health/);
  assert.match(smokeScript, /ace-mcp-smoke-/);
  assert.match(smokeScript, /waitForExit/);
  assert.match(smokeScript, /SIGKILL/);
  assert.doesNotMatch(smokeScript, /ace-mcp smoke /);
  assert.match(benchmarkScript, /eventLoopDelay/);
  assert.match(benchmarkScript, /healthP95Ms/);
  assert.match(benchmarkScript, /searchP95Ms/);
  assert.match(benchmarkScript, /--project/);
  assert.match(benchmarkScript, /--json/);
  assert.match(benchmarkScript, /--timeout-ms/);
  assert.match(benchmarkScript, /--smoke/);
  assert.match(benchmarkScript, /getLogs/);
  assert.match(benchmarkScript, /ACE_MCP_BENCHMARK_SMOKE_HOME/);
  assert.match(benchmarkScript, /ACE_MCP_AUTO_WATCH/);
  assert.match(benchmarkScript, /extractResultCount/);
  assert.match(benchmarkScript, /smoke benchmark did not return search results/);
  assert.match(reindexScript, /--dry-run/);
  assert.match(reindexScript, /--summary/);
  assert.match(reindexScript, /--include-parent/);
  assert.match(reindexScript, /confirmParentDirectory/);
  assert.match(cmdInstall, /npm install --omit=dev/);
  assert.match(cmdInstall, /better-sqlite3/);
  assert.match(cmdInstall, /--doctor/);
  assert.match(psInstall, /npm install --omit=dev/);
  assert.match(psInstall, /ExecutionPolicy/);
  assert.match(psInstall, /--doctor/);
});

test("Windows README documents zip installation and MCP client command paths", () => {
  const windowsReadme = readFileSync(path.join(rootDir, "scripts/README-WINDOWS.md"), "utf8");

  assert.match(windowsReadme, /ace-mcp-v4\.8\.2-win-x64\.zip/);
  assert.match(windowsReadme, /reindex-projects\.mjs/);
  assert.match(windowsReadme, /install\.ps1/);
  assert.match(windowsReadme, /start-web\.cmd/);
  assert.match(windowsReadme, /ace-mcp\.cmd/);
  assert.match(windowsReadme, /better-sqlite3/);
  assert.match(windowsReadme, /ExecutionPolicy/);
});

test("release checklist records the v4.8.2 verification gates", () => {
  const checklist = readFileSync(path.join(rootDir, "docs/release-checklist.md"), "utf8");

  assert.match(checklist, /v4\.8\.2/);
  assert.match(checklist, /npm test/);
  assert.match(checklist, /npm run build/);
  assert.match(checklist, /npm run release:pack/);
  assert.match(checklist, /npm run release:win/);
  assert.match(checklist, /npm run release:smoke/);
  assert.match(checklist, /npm run release:benchmark/);
  assert.match(checklist, /scripts\/benchmark-search\.mjs/);
  assert.match(checklist, /scripts\/reindex-projects\.mjs/);
  assert.match(checklist, /git tag -a v4\.8\.2/);
});

test("web static controls expose maximum shortcuts for snippet and context sizing", () => {
  const html = readFileSync(path.join(rootDir, "src/web/static/index.html"), "utf8");
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");

  assert.match(html, /id="top-k-max"[^>]*>最大<\/button>/);
  assert.match(html, /id="include-context-lines"[^>]*max="500"/);
  assert.match(html, /id="include-context-lines-max"[^>]*>最大<\/button>/);
  assert.match(html, /id="snippet-range-max"[^>]*>最大<\/button>/);
  assert.match(html, /id="qa-max-sources-max"[^>]*>最大<\/button>/);
  assert.match(html, /id="qa-max-context-tokens"[^>]*max="200000"/);
  assert.match(html, /id="qa-max-context-tokens-max"[^>]*>最大<\/button>/);
  assert.match(html, /id="qa-max-tokens-max"[^>]*>最大<\/button>/);
  assert.match(html, /id="qa-timeout-max"[^>]*>最大<\/button>/);
  assert.match(html, /id="qa-retries-max"[^>]*>最大<\/button>/);

  assert.match(appJs, /const TOP_K_MAX = 50;/);
  assert.match(appJs, /const MAX_INCLUDE_CONTEXT_LINES = 500;/);
  assert.match(appJs, /const FILE_SNIPPET_MAX_END_LINE = 999999;/);
  assert.match(appJs, /const QA_MAX_SOURCES = 100;/);
  assert.match(appJs, /const QA_MAX_CONTEXT_TOKENS = 200000;/);
  assert.match(appJs, /const QA_MAX_TOKENS = 32768;/);
  assert.match(appJs, /const QA_TIMEOUT_SECONDS_MAX = 600;/);
  assert.match(appJs, /const QA_RETRIES_MAX = 5;/);
  assert.match(appJs, /top-k-max[\s\S]*topKInput\.value = String\(TOP_K_MAX\)/);
  assert.match(appJs, /include-context-lines-max[\s\S]*includeContextLinesInput\.value = String\(MAX_INCLUDE_CONTEXT_LINES\)/);
  assert.match(appJs, /snippet-range-max[\s\S]*snippetStartInput\.value = "1"[\s\S]*snippetEndInput\.value = String\(FILE_SNIPPET_MAX_END_LINE\)/);
  assert.match(appJs, /qa-max-sources-max[\s\S]*qaMaxSourcesInput\.value = String\(QA_MAX_SOURCES\)/);
  assert.match(appJs, /qa-max-context-tokens-max[\s\S]*qaMaxContextTokensInput\.value = String\(QA_MAX_CONTEXT_TOKENS\)/);
  assert.match(appJs, /qa-max-tokens-max[\s\S]*qaMaxTokensInput\.value = String\(QA_MAX_TOKENS\)/);
  assert.match(appJs, /qa-timeout-max[\s\S]*qaTimeoutInput\.value = String\(QA_TIMEOUT_SECONDS_MAX\)/);
  assert.match(appJs, /qa-retries-max[\s\S]*qaRetriesInput\.value = String\(QA_RETRIES_MAX\)/);
  assert.match(appJs, /const retries = Number\(qaRetriesInput\?\.value \|\| 2\)/);
  assert.match(appJs, /timeoutSeconds: timeoutSec,[\s\S]*retries,/);
  assert.match(appJs, /maxContextTokens,/);
});

test("web static page exposes runtime status and effective request parameters", () => {
  const html = readFileSync(path.join(rootDir, "src/web/static/index.html"), "utf8");
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");

  assert.match(html, /id="service-status-strip"/);
  assert.match(html, /id="service-version"/);
  assert.match(html, /id="service-watch-status"/);
  assert.match(html, /id="service-projects"/);
  assert.match(html, /id="service-latest-index"/);
  assert.match(html, /id="service-active-tasks"/);
  assert.match(html, /id="qa-effective-params"/);
  assert.match(html, /data-value-hint="qa-max-sources"/);
  assert.match(html, /data-value-hint="include-context-lines"/);
  assert.match(html, /data-value-hint="qa-retries"/);

  assert.match(appJs, /function renderServiceStatus\(/);
  assert.match(appJs, /serviceActiveTasksEl/);
  assert.match(appJs, /request\("GET", "\/health"\)[\s\S]*renderServiceStatus/);
  assert.match(appJs, /PARENT_DIRECTORY_REQUIRES_CONFIRMATION/);
  assert.match(appJs, /confirmParentDirectory/);
  assert.match(appJs, /function updateBoundedValueHints\(/);
  assert.match(appJs, /function renderQaEffectiveParams\(/);
  assert.match(appJs, /finalData\?\.request[\s\S]*renderQaEffectiveParams/);
});
