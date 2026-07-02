import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
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

interface PackageLockJson {
  packages?: Record<string, { version?: string }>;
  version: string;
}

test("package manifest is ready for npm and tgz global installation", () => {
  const pkg = readJson<PackageJson>("package.json");
  const lock = readJson<PackageLockJson>("package-lock.json");
  const versionTs = readFileSync(path.join(rootDir, "src/version.ts"), "utf8");

  assert.equal(pkg.version, "4.9.5");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages?.[""]?.version, pkg.version);
  assert.match(versionTs, /APP_VERSION\s*=\s*"4\.9\.5"/);
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
  assert.equal(pkg.scripts["release:verify-assets"], "node scripts/verify-release-assets.mjs");
  assert.equal(pkg.scripts["release:publish"], "node scripts/publish-gitee-release.mjs");
  assert.equal(pkg.scripts["security:secrets"], "node scripts/check-secrets.mjs");
  assert.equal(pkg.scripts["release:check"], "npm test && npm run build && npm run release:pack && npm run release:win && npm run security:secrets && npm run release:smoke && npm run release:benchmark");
  assert.equal(pkg.scripts["benchmark:search"], "node scripts/benchmark-search.mjs");
  assert.equal(pkg.scripts["maintenance:reindex"], "node scripts/reindex-projects.mjs");
  assert.match(pkg.scripts.test, /src\/adapters\/java\/index\.test\.ts/);
});

test("CLI bin entrypoint is directly executable after global npm install", () => {
  const entrypoint = readFileSync(path.join(rootDir, "src/index.ts"), "utf8");

  assert.equal(entrypoint.startsWith("#!/usr/bin/env node\n"), true);
});

test("local runtime directories are ignored from release worktree noise", () => {
  const gitignore = readFileSync(path.join(rootDir, ".gitignore"), "utf8");

  assert.match(gitignore, /^\/\.ace-mcp$/m);
  assert.match(gitignore, /^\/\.codex$/m);
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
  const verifyAssetsScriptPath = path.join(rootDir, "scripts/verify-release-assets.mjs");
  const checkSecretsScriptPath = path.join(rootDir, "scripts/check-secrets.mjs");
  const publishScriptPath = path.join(rootDir, "scripts/publish-gitee-release.mjs");
  const reindexScriptPath = path.join(rootDir, "scripts/reindex-projects.mjs");
  const cmdInstallPath = path.join(rootDir, "scripts/install-windows.cmd");
  const psInstallPath = path.join(rootDir, "scripts/install-windows.ps1");

  assert.equal(existsSync(packageScriptPath), true);
  assert.equal(existsSync(smokeScriptPath), true);
  assert.equal(existsSync(benchmarkScriptPath), true);
  assert.equal(existsSync(verifyAssetsScriptPath), true);
  assert.equal(existsSync(checkSecretsScriptPath), true);
  assert.equal(existsSync(publishScriptPath), true);
  assert.equal(existsSync(reindexScriptPath), true);
  assert.equal(existsSync(cmdInstallPath), true);
  assert.equal(existsSync(psInstallPath), true);

  const packageScript = readFileSync(packageScriptPath, "utf8");
  const smokeScript = readFileSync(smokeScriptPath, "utf8");
  const benchmarkScript = readFileSync(benchmarkScriptPath, "utf8");
  const verifyAssetsScript = readFileSync(verifyAssetsScriptPath, "utf8");
  const checkSecretsScript = readFileSync(checkSecretsScriptPath, "utf8");
  const publishScript = readFileSync(publishScriptPath, "utf8");
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
  assert.match(packageScript, /scripts\/verify-release-assets\.mjs/);
  assert.match(packageScript, /scripts\/check-secrets\.mjs/);
  assert.match(packageScript, /scripts\/publish-gitee-release\.mjs/);
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
  assert.match(verifyAssetsScript, /verify-release-assets ok/);
  assert.match(verifyAssetsScript, /ace-mcp-v\$\{version\}-win-x64\.zip/);
  assert.match(checkSecretsScript, /--token-env/);
  assert.match(checkSecretsScript, /GITEE_TOKEN/);
  assert.match(checkSecretsScript, /git log --all/);
  assert.match(checkSecretsScript, /npm pack/);
  assert.match(checkSecretsScript, /unzip -p/);
  assert.match(checkSecretsScript, /check-secrets ok/);
  assert.match(checkSecretsScript, /redacted/);
  assert.doesNotMatch(checkSecretsScript, /example-secret-token-value/);
  assert.match(publishScript, /GITEE_TOKEN/);
  assert.match(publishScript, /\/api\/v5\/repos\/\$\{owner\}\/\$\{repo\}\/releases/);
  assert.match(publishScript, /\/releases\/\$\{release\.id\}\/attach_files/);
  assert.match(publishScript, /ace-mcp-\$\{version\}\.tgz/);
  assert.match(publishScript, /ace-mcp-v\$\{version\}-win-x64\.zip/);
  assert.match(publishScript, /verify-release-assets\.mjs/);
  assert.match(reindexScript, /--dry-run/);
  assert.match(reindexScript, /--summary/);
  assert.match(reindexScript, /--include-parent/);
  assert.match(reindexScript, /confirmParentDirectory/);
  assert.match(reindexScript, /const taskId = body\.data\?\.taskId/);
  assert.match(reindexScript, /\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}/);
  assert.match(cmdInstall, /npm install --omit=dev/);
  assert.match(cmdInstall, /better-sqlite3/);
  assert.match(cmdInstall, /--doctor/);
  assert.match(psInstall, /npm install --omit=dev/);
  assert.match(psInstall, /ExecutionPolicy/);
  assert.match(psInstall, /--doctor/);
});

test("macOS quick install script and docs are packaged for one-command setup", () => {
  const installScriptPath = path.join(rootDir, "scripts/install-macos.sh");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const checklist = readFileSync(path.join(rootDir, "docs/release-checklist.md"), "utf8");

  assert.equal(existsSync(installScriptPath), true);

  const installScript = readFileSync(installScriptPath, "utf8");
  assert.equal(installScript.startsWith("#!/usr/bin/env bash\n"), true);
  assert.match(installScript, /set -euo pipefail/);
  assert.match(installScript, /ACE_MCP_VERSION/);
  assert.match(installScript, /curl -fL/);
  assert.match(installScript, /gitee\.com\/AndrewFengCode\/ace-mcp\/releases\/download\/v/);
  assert.match(installScript, /npm install -g/);
  assert.match(installScript, /ace-mcp --doctor/);
  assert.match(installScript, /brew install node@22/);

  assert.match(readme, /### macOS 一键安装/);
  assert.match(readme, /bash -c "\$\(curl -fsSL https:\/\/gitee\.com\/AndrewFengCode\/ace-mcp\/raw\/v4\.9\.5\/scripts\/install-macos\.sh\)"/);
  assert.match(readme, /依赖需求清单/);
  assert.match(readme, /Node\.js >=18\.18\.0/);
  assert.match(readme, /npm/);
  assert.match(readme, /curl/);
  assert.match(readme, /Xcode Command Line Tools/);
  assert.match(readme, /Homebrew/);
  assert.match(readme, /ACE_MCP_VERSION=4\.9\.5/);

  assert.match(checklist, /bash -n scripts\/install-macos\.sh/);
  assert.match(checklist, /scripts\/install-macos\.sh/);
});

test("release asset verifier documents Gitee tag and downloadable artifacts", () => {
  const verifierPath = path.join(rootDir, "scripts/verify-release-assets.mjs");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const checklist = readFileSync(path.join(rootDir, "docs/release-checklist.md"), "utf8");

  assert.equal(existsSync(verifierPath), true);

  const verifier = readFileSync(verifierPath, "utf8");
  assert.match(verifier, /--version/);
  assert.match(verifier, /--base-url/);
  assert.match(verifier, /--timeout-ms/);
  assert.match(verifier, /releases\/tag\/v\$\{version\}/);
  assert.match(verifier, /releases\/download\/v\$\{version\}\/ace-mcp-\$\{version\}\.tgz/);
  assert.match(verifier, /releases\/download\/v\$\{version\}\/ace-mcp-v\$\{version\}-win-x64\.zip/);
  assert.match(verifier, /raw\/v\$\{version\}\/scripts\/install-macos\.sh/);
  assert.match(verifier, /verify-release-assets ok/);

  assert.match(readme, /npm run release:verify-assets -- --version 4\.9\.5/);
  assert.match(readme, /raw\/v4\.9\.5\/scripts\/install-macos\.sh/);
  assert.doesNotMatch(readme, /raw\/master\/scripts\/install-macos\.sh/);

  assert.match(checklist, /npm run release:verify-assets -- --version 4\.9\.5/);
  assert.match(checklist, /ace-mcp-4\.9\.5\.tgz/);
  assert.match(checklist, /ace-mcp-v4\.9\.5-win-x64\.zip/);
});

test("Gitee release publisher documents token-based automated release upload", () => {
  const publishScriptPath = path.join(rootDir, "scripts/publish-gitee-release.mjs");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const checklist = readFileSync(path.join(rootDir, "docs/release-checklist.md"), "utf8");

  assert.equal(existsSync(publishScriptPath), true);

  const publishScript = readFileSync(publishScriptPath, "utf8");
  assert.match(publishScript, /--version/);
  assert.match(publishScript, /--owner/);
  assert.match(publishScript, /--repo/);
  assert.match(publishScript, /--token-env/);
  assert.match(publishScript, /--dry-run/);
  assert.match(publishScript, /git rev-parse --verify v\$\{version\}\^\{\}/);
  assert.match(publishScript, /target_commitish/);
  assert.match(publishScript, /DELETE/);
  assert.match(publishScript, /FormData/);
  assert.match(publishScript, /release:publish ok/);

  assert.match(readme, /npm run release:publish -- --version 4\.9\.5/);
  assert.match(readme, /GITEE_TOKEN/);
  assert.match(readme, /release:verify-assets/);

  assert.match(checklist, /npm run release:publish -- --version 4\.9\.5/);
  assert.match(checklist, /GITEE_TOKEN/);
});

test("Windows README documents zip installation and MCP client command paths", () => {
  const windowsReadme = readFileSync(path.join(rootDir, "scripts/README-WINDOWS.md"), "utf8");

  assert.match(windowsReadme, /ace-mcp-v4\.9\.5-win-x64\.zip/);
  assert.match(windowsReadme, /reindex-projects\.mjs/);
  assert.match(windowsReadme, /install\.ps1/);
  assert.match(windowsReadme, /start-web\.cmd/);
  assert.match(windowsReadme, /ace-mcp\.cmd/);
  assert.match(windowsReadme, /better-sqlite3/);
  assert.match(windowsReadme, /ExecutionPolicy/);
});

test("release checklist records the v4.9.5 verification gates", () => {
  const checklist = readFileSync(path.join(rootDir, "docs/release-checklist.md"), "utf8");

  assert.match(checklist, /v4\.9\.5/);
  assert.match(checklist, /npm test/);
  assert.match(checklist, /npm run security:secrets/);
  assert.match(checklist, /npm run build/);
  assert.match(checklist, /npm run release:pack/);
  assert.match(checklist, /npm run release:win/);
  assert.match(checklist, /npm run release:smoke/);
  assert.match(checklist, /npm run release:benchmark/);
  assert.match(checklist, /npm run release:verify-assets/);
  assert.match(checklist, /npm run release:publish/);
  assert.match(checklist, /scripts\/benchmark-search\.mjs/);
  assert.match(checklist, /scripts\/reindex-projects\.mjs/);
  assert.match(checklist, /git tag -a v4\.9\.5/);
});

test("web project profile diagnostics are wired through API and static controls", () => {
  const html = readFileSync(path.join(rootDir, "src/web/static/index.html"), "utf8");
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(html, /id="run-project-profile"/);
  assert.match(html, /搜索画像/);
  assert.match(appJs, /\/api\/project-profile\?projectRootPath=/);
  assert.match(appJs, /function renderProjectProfileSummary\(/);
  assert.match(appJs, /diagnostic-suggestion/);
  assert.match(appJs, /RUN_FULL_INDEX/);
  assert.match(appJs, /GENERATE_SUMMARY/);
  assert.match(appJs, /WARM_VECTOR_INDEX/);
  assert.match(appJs, /REVIEW_FAILED_FILES/);
  assert.match(readme, /当前版本：`v4\.9\.5`/);
  assert.match(readme, /项目级搜索画像/);
  assert.match(readme, /\/api\/project-profile/);
  assert.match(changelog, /## \[4\.9\.5\]/);
  assert.match(changelog, /Project search profile diagnostics/);
  assert.match(roadmap, /项目级搜索画像/);
  assert.match(roadmap, /v4\.9\.5/);
});

test("web project profile suggestions provide one-click repair actions", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(appJs, /data-profile-fix="\$\{escapeHtml\(suggestion\.code\)\}"/);
  assert.match(appJs, /function bindProjectProfileActions\(/);
  assert.match(appJs, /function runProjectProfileFix\(/);
  assert.match(appJs, /function refreshProjectProfile\(/);
  assert.match(appJs, /RUN_FULL_INDEX[\s\S]*submitIndexTask\(\{[\s\S]*mode: "full"/);
  assert.match(appJs, /GENERATE_SUMMARY[\s\S]*request\("POST", "\/api\/summary\/generate"/);
  assert.match(appJs, /WARM_VECTOR_INDEX[\s\S]*request\("POST", "\/api\/index\/warm"/);
  assert.match(appJs, /REVIEW_FAILED_FILES[\s\S]*latestIndexing\?\.failedFiles/);
  assert.match(appJs, /await pollTask\(taskId\)/);
  assert.match(appJs, /await refreshTaskCenter\(\)/);
  assert.match(appJs, /await refreshProjectProfile\(projectRootPath\)/);
  assert.match(appJs, /bindProjectProfileActions\(payload\)/);
  assert.match(readme, /画像一键修复/);
  assert.match(readme, /RUN_FULL_INDEX/);
  assert.match(changelog, /Project profile one-click fixes/);
  assert.match(roadmap, /画像一键修复/);
});

test("web project profile repairs render visible outcomes and failed-file details", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(appJs, /function summarizeProjectProfile\(/);
  assert.match(appJs, /function diffProjectProfile\(/);
  assert.match(appJs, /function renderProfileRepairResult\(/);
  assert.match(appJs, /function renderFailedFileDetails\(/);
  assert.match(appJs, /profile-repair-result/);
  assert.match(appJs, /profile-repair-delta/);
  assert.match(appJs, /failed-file-detail/);
  assert.match(appJs, /data-copy-path="\$\{escapeHtml\(filePath\)\}"/);
  assert.match(appJs, /copyText\(filePath\)/);
  assert.match(appJs, /beforeSummary/);
  assert.match(appJs, /afterSummary/);
  assert.match(appJs, /durationMs/);
  assert.match(appJs, /taskStatus/);
  assert.match(appJs, /renderProfileRepairResult\(code, beforeProfile, afterProfile, taskResult\)/);
  assert.match(appJs, /renderFailedFileDetails\(failedFiles, projectRootPath\)/);
  assert.match(readme, /画像修复结果可见化/);
  assert.match(readme, /失败文件明细/);
  assert.match(changelog, /Profile repair result visibility/);
  assert.match(roadmap, /画像修复结果可见化/);
});

test("web search results explain why each result matched", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const css = readFileSync(path.join(rootDir, "src/web/static/css/main.css"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(appJs, /function renderSearchMatchExplanation\(/);
  assert.match(appJs, /function describeSearchMatchSource\(/);
  assert.match(appJs, /function renderSearchResultExplanations\(/);
  assert.match(appJs, /function escapeHtmlAttribute\(/);
  assert.match(appJs, /source\.explanation\?\.matchedSources/);
  assert.match(appJs, /source\.explanation\?\.matchedTokens/);
  assert.match(appJs, /source\.explanation\?\.tokenCoverage/);
  assert.match(appJs, /source\.explanation\?\.pathMatch/);
  assert.match(appJs, /source\.explanation\?\.symbolMatch/);
  assert.match(appJs, /source\.explanation\?\.snippetMatch/);
  assert.match(appJs, /source\.reason/);
  assert.match(appJs, /source\.score/);
  assert.match(appJs, /search-match-explanation/);
  assert.match(appJs, /search-match-chip/);
  assert.match(appJs, /search-result-explanations/);
  assert.match(appJs, /renderSearchMatchExplanation\(source\)/);
  assert.match(appJs, /renderSearchResultExplanations\(payload\.results/);
  assert.match(css, /\.search-match-explanation/);
  assert.match(css, /\.search-match-chip/);
  assert.match(css, /\.search-result-explanations/);
  assert.match(readme, /搜索结果命中解释/);
  assert.match(readme, /为什么命中/);
  assert.match(changelog, /Search result match explanations/);
  assert.match(roadmap, /搜索结果命中解释/);
});

test("web search match explanation escapes attribute values and falls back to reason", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const element = () => {
    const node = {
      addEventListener() {},
      appendChild() {},
      append() {},
      classList: { add() {}, remove() {}, toggle() { return false; } },
      click() {},
      dataset: {},
      hidden: false,
      innerHTML: "",
      options: [{ text: "" }],
      parentElement: null,
      querySelector() { return null; },
      querySelectorAll() { return []; },
      remove() {},
      select() {},
      selectedIndex: 0,
      setAttribute() {},
      style: {},
      value: "",
    };
    Object.defineProperty(node, "textContent", {
      get() {
        return node.innerHTML;
      },
      set(value) {
        node.innerHTML = String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      },
    });
    return node;
  };
  const context = vm.createContext({
    AbortController,
    alert() {},
    clearTimeout,
    confirm() { return false; },
    console,
    document: {
      addEventListener() {},
      body: element(),
      createElement() { return element(); },
      execCommand() { return true; },
      getElementById() { return element(); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    fetch() {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ projects: [], tasks: [] }),
      });
    },
    localStorage: {
      getItem() { return null; },
      removeItem() {},
      setItem() {},
    },
    navigator: {},
    setInterval() { return 1; },
    setTimeout,
    URLSearchParams,
    window: { confirm() { return false; }, isSecureContext: false },
  });

  vm.runInContext(appJs, context);
  const html = vm.runInContext(`renderSearchMatchExplanation({
    reason: "lexical+symbol",
    score: 0.875,
    explanation: {
      matchedSources: ["lexical"],
      matchedTokens: ['safe" onmouseover="alert(1)'],
      tokenCoverage: { matched: 1, total: 2 },
      pathMatch: 'src/" onclick="alert(2)',
      symbolMatch: "SearchService",
      snippetMatch: true
    }
  })`, context) as string;

  assert.match(html, /为什么命中/);
  assert.match(html, /文本命中/);
  assert.match(html, /Score 0\.88/);
  assert.match(html, /safe" onmouseover="alert\(1\)/);
  assert.match(html, /title="\{&quot;matchedSources&quot;/);
  assert.doesNotMatch(html, /title="[^"]*"matchedSources/);
  const openingTag = html.slice(0, html.indexOf(">") + 1);
  assert.doesNotMatch(openingTag, /"\s+onmouseover=/);
  assert.doesNotMatch(openingTag, /"\s+onclick=/);

  const fallbackHtml = vm.runInContext(`renderSearchMatchExplanation({ reason: "path+semantic", score: 0.2 })`, context) as string;
  assert.match(fallbackHtml, /路径命中/);
  assert.match(fallbackHtml, /语义召回/);

  const actionsHtml = vm.runInContext(`renderSearchResultActions({
    filePath: "src/example.ts",
    startLine: 7,
    snippet: "  const answer = 42;\\n"
  })`, context) as string;
  assert.match(actionsHtml, /data-source-reference="src\/example\.ts:7"/);
  assert.match(actionsHtml, /data-source-snippet="  const answer = 42;\n"/);
});

test("web search and QA results expose copy actions and explanation toggles", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const css = readFileSync(path.join(rootDir, "src/web/static/css/main.css"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(appJs, /function formatSourceReference\(/);
  assert.match(appJs, /function getSourceSnippetText\(/);
  assert.match(appJs, /function hasSourceSnippet\(/);
  assert.match(appJs, /function renderSearchResultActions\(/);
  assert.match(appJs, /function bindSearchResultActions\(/);
  assert.match(appJs, /function bindSearchExplanationToggles\(/);
  assert.match(appJs, /data-copy-kind="path"/);
  assert.match(appJs, /data-copy-kind="reference"/);
  assert.match(appJs, /data-copy-kind="snippet"/);
  assert.match(appJs, /data-source-path="\$\{escapeHtmlAttribute\(source\.filePath/);
  assert.match(appJs, /data-source-reference="\$\{escapeHtmlAttribute\(formatSourceReference\(source\)\)\}"/);
  assert.match(appJs, /data-source-snippet="\$\{escapeHtmlAttribute\(snippet\)\}"/);
  assert.match(appJs, /dataset\.searchActionBound/);
  assert.match(appJs, /button\.dataset\.searchActionBound = "1"/);
  assert.match(appJs, /copyTextToClipboard\(value, button\)/);
  assert.match(appJs, /search-result-action/);
  assert.match(appJs, /search-explanations-toggle/);
  assert.match(appJs, /data-explanation-action="expand"/);
  assert.match(appJs, /data-explanation-action="collapse"/);
  assert.match(appJs, /search-explanations-collapsed/);
  assert.match(appJs, /bindSearchResultActions\(\)/);
  assert.match(appJs, /bindSearchExplanationToggles\(\)/);
  assert.match(appJs, /renderSearchResultActions\(item\)/);
  assert.match(appJs, /renderSearchResultActions\(source\)/);
  assert.match(css, /\.search-result-actions/);
  assert.match(css, /\.search-result-action/);
  assert.match(css, /\.search-explanations-toggle/);
  assert.match(css, /\.search-explanations-collapsed/);
  assert.match(readme, /搜索结果可操作化/);
  assert.match(readme, /复制路径/);
  assert.match(readme, /复制引用/);
  assert.match(readme, /复制代码片段/);
  assert.match(changelog, /Search result actions/);
  assert.match(roadmap, /搜索结果可操作化/);
});

test("release secret scanner guards env tokens without leaking values", () => {
  const scriptPath = path.join(rootDir, "scripts/check-secrets.mjs");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const checklist = readFileSync(path.join(rootDir, "docs/release-checklist.md"), "utf8");

  assert.equal(existsSync(scriptPath), true);

  const script = readFileSync(scriptPath, "utf8");
  assert.match(script, /--token-env/);
  assert.match(script, /--include-artifacts/);
  assert.match(script, /--skip-history/);
  assert.match(script, /process\.env\[options\.tokenEnv\]/);
  assert.match(script, /scanProjectFiles/);
  assert.match(script, /scanGitHistory/);
  assert.match(script, /scanPackedArtifacts/);
  assert.match(script, /redacted/);
  assert.match(script, /check-secrets ok/);
  assert.doesNotMatch(script, /example-secret-token-value/);

  assert.match(readme, /npm run security:secrets/);
  assert.match(readme, /不会打印 token 内容/);
  assert.match(checklist, /npm run security:secrets/);
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
  assert.match(html, /id="task-list"/);
  assert.match(html, /id="task-filter-type"/);
  assert.match(html, /id="task-filter-status"/);
  assert.match(html, /value="canceled">已取消/);
  assert.match(html, /id="refresh-tasks"/);
  assert.match(html, /id="qa-effective-params"/);
  assert.match(html, /data-value-hint="qa-max-sources"/);
  assert.match(html, /data-value-hint="include-context-lines"/);
  assert.match(html, /data-value-hint="qa-retries"/);

  assert.match(appJs, /function renderServiceStatus\(/);
  assert.match(appJs, /serviceActiveTasksEl/);
  assert.match(appJs, /function pollTask\(/);
  assert.match(appJs, /function submitIndexTask\(/);
  assert.match(appJs, /function renderTaskCenter\(/);
  assert.match(appJs, /function refreshTaskCenter\(/);
  assert.match(appJs, /class="btn-secondary btn-small task-cancel"/);
  assert.match(appJs, /\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/cancel/);
  assert.match(appJs, /params\.set\("type", taskFilterTypeInput\.value\)/);
  assert.match(appJs, /params\.set\("status", taskFilterStatusInput\.value\)/);
  assert.match(appJs, /params\.set\("projectRootPath", projectRootInput\.value\.trim\(\)\)/);
  assert.match(appJs, /\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}/);
  assert.match(appJs, /request\("GET", "\/health"\)[\s\S]*renderServiceStatus/);
  assert.match(appJs, /PARENT_DIRECTORY_REQUIRES_CONFIRMATION/);
  assert.match(appJs, /confirmParentDirectory/);
  assert.match(appJs, /function updateBoundedValueHints\(/);
  assert.match(appJs, /function renderQaEffectiveParams\(/);
  assert.match(appJs, /finalData\?\.request[\s\S]*renderQaEffectiveParams/);
});
