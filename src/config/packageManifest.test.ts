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
  const autostartSource = readFileSync(path.join(rootDir, "src/autostart/index.ts"), "utf8");

  assert.equal(pkg.version, "4.10.5");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages?.[""]?.version, pkg.version);
  assert.match(versionTs, /APP_VERSION\s*=\s*"4\.10\.5"/);
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.bin["ace-mcp"], "dist/index.js");
  assert.equal(pkg.bin["ace-mcp-web"], "scripts/start-web.mjs");
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("scripts"));
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.includes("CHANGELOG.md"));
  assert.ok(pkg.files.includes("!dist/**/*.test.*"));
  assert.ok(pkg.files.includes("!dist/test/**"));
  assert.equal(pkg.scripts.build, "tsc -p tsconfig.json && node scripts/copy-web-static.mjs");
  assert.equal(pkg.scripts["release:pack"], "npm run build && npm pack --cache .npm-cache");
  assert.equal(pkg.scripts["release:win"], "npm run build && node scripts/package-windows.mjs");
  assert.equal(pkg.scripts["release:smoke"], "node scripts/smoke-release.mjs");
  assert.equal(pkg.scripts["release:benchmark"], "node scripts/benchmark-search.mjs --smoke --during-index");
  assert.equal(pkg.scripts["release:verify-assets"], "node scripts/verify-release-assets.mjs");
  assert.equal(pkg.scripts["release:publish"], "node scripts/publish-gitee-release.mjs");
  assert.equal(pkg.scripts["security:secrets"], "node scripts/check-secrets.mjs");
  assert.equal(pkg.scripts["release:check"], "npm test && npm run test:dist-worker && npm run release:pack && npm run release:win && npm run security:secrets && npm run release:smoke && npm run release:benchmark");
  assert.match(pkg.scripts["test:dist-worker"], /npm run build/);
  assert.match(pkg.scripts["test:dist-worker"], /dist\/core\/storage\/sqliteIndexWorker\.test\.js/);
  assert.equal(pkg.scripts["benchmark:search"], "node scripts/benchmark-search.mjs");
  assert.equal(pkg.scripts["maintenance:reindex"], "node scripts/reindex-projects.mjs");
  assert.match(pkg.scripts.test, /src\/adapters\/java\/index\.test\.ts/);
  assert.match(pkg.scripts.test, /src\/core\/common\/logger\.test\.ts/);
  assert.match(pkg.scripts.test, /src\/config\/settings\.test\.ts/);
  assert.match(pkg.scripts.test, /src\/core\/search\/projectRouter\.test\.ts/);
  assert.match(pkg.scripts.test, /src\/core\/project\/gitHelper\.test\.ts/);
  assert.match(pkg.scripts.test, /src\/core\/project\/projectHierarchy\.test\.ts/);
  assert.match(pkg.scripts.test, /src\/core\/storage\/sqliteIndexWorker\.test\.ts/);
  assert.match(pkg.scripts.test, /src\/server\/tools\/resolveProjects\.test\.ts/);
  assert.match(pkg.scripts.test, /src\/test\/benchmarkSearchCli\.test\.mjs/);
  assert.match(autostartSource, /<key>ACE_MCP_LOG_TO_STDERR<\/key>\s*<string>false<\/string>/);
  assert.match(autostartSource, /Environment=ACE_MCP_LOG_TO_STDERR=false/);
});

test("web automatic project routing preserves manual and QA conversation ownership", async () => {
  const html = readFileSync(path.join(rootDir, "src/web/static/index.html"), "utf8");
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const css = readFileSync(path.join(rootDir, "src/web/static/css/main.css"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");
  assert.match(html, /<option value="">自动识别（全部项目）<\/option>/);
  assert.match(html, /id="project-route-status"/);
  assert.match(appJs, /resolveProjectRootForQuery\(query\)/);
  assert.match(appJs, /resolveProjectRootForQuery\(question/);
  assert.match(appJs, /projectRoot = await resolveQaProjectRootForQuestion\(question\)/);
  assert.match(appJs, /class="project-route-candidate"/);
  assert.match(appJs, /selectProjectRouteCandidate\(projectRootPath\)/);
  assert.match(css, /\.project-route-candidates/);
  assert.match(css, /\.primary-panel, \.secondary-panel \{[^}]*min-width: 0/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.input-row input \{[^}]*flex: 1 1 100%/);
  assert.match(readme, /resolve_projects/);
  assert.match(readme, /自动识别项目/);
  assert.match(changelog, /Automatic project routing/);
  assert.match(roadmap, /自动项目路由/);

  const elements = new Map<string, any>();
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const makeElement = (id: string) => {
    const node = {
      checked: false,
      classList: { add() {}, remove() {}, toggle() { return false; } },
      click() {},
      dataset: {} as Record<string, string>,
      disabled: false,
      hidden: false,
      id,
      innerHTML: "",
      options: [{ text: "" }],
      parentElement: null,
      selectedIndex: 0,
      style: {},
      textContent: "",
      value: "",
      addEventListener(type: string, handler: (...args: any[]) => unknown) {
        const key = `${id}:${type}`;
        listeners.set(key, [...(listeners.get(key) || []), handler]);
      },
      append() {},
      appendChild() {},
      focus() {},
      getAttribute() { return ""; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      remove() {},
      select() {},
      setAttribute() {},
    };
    elements.set(id, node);
    return node;
  };
  const element = (id: string) => elements.get(id) || makeElement(id);
  const routeRequests: Array<{ body?: string; url: string }> = [];
  let routeDecision: "single" | "multiple" = "single";
  const storage = new Map<string, string>();
  const context = vm.createContext({
    AbortController,
    alert() {},
    clearInterval() {},
    clearTimeout,
    confirm() { return false; },
    console,
    document: {
      addEventListener() {},
      body: element("body"),
      createElement() { return makeElement("created"); },
      execCommand() { return true; },
      getElementById(id: string) { return element(id); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    fetch(url: string, options: { body?: string } = {}) {
      if (url === "/api/projects/resolve") {
        routeRequests.push({ body: options.body, url });
        const selectedProjectRootPaths = routeDecision === "single"
          ? ["/work/change-service"]
          : ["/work/change-service", "/work/refund-service"];
        const candidates = selectedProjectRootPaths.map((projectRootPath, index) => ({
          confidence: index === 0 ? 0.55 : 0.45,
          evidence: [],
          matchedTerms: ["flowswitcher"],
          projectRootPath,
          score: index === 0 ? 1.1 : 1,
        }));
        if (routeDecision === "multiple") {
          candidates.push({
            confidence: 0.2,
            evidence: [],
            matchedTerms: ["flowswitcher"],
            projectRootPath: "/work/observer-service",
            score: 0.4,
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              candidates,
              decision: routeDecision,
              durationMs: 2,
              query: "FlowSwitcher",
              selectedProjectRootPaths,
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ projects: [], tasks: [] }),
      });
    },
    localStorage: {
      getItem(key: string) { return storage.get(key) || null; },
      removeItem(key: string) { storage.delete(key); },
      setItem(key: string, value: string) { storage.set(key, value); },
    },
    navigator: {},
    setInterval() { return 1; },
    setTimeout,
    URLSearchParams,
    window: { confirm() { return false; }, isSecureContext: false, location: { href: "" } },
  });

  vm.runInContext(appJs, context);
  const automaticRoot = await vm.runInContext(`resolveProjectRootForQuery("FlowSwitcher")`, context);
  assert.equal(automaticRoot, "/work/change-service");
  assert.equal(vm.runInContext(`getProjectRootPath()`, context), "/work/change-service");
  assert.equal(routeRequests.length, 1);

  element("project-root").value = "/work/manual-service";
  const manualRoot = await vm.runInContext(`resolveProjectRootForQuery("OtherQuery")`, context);
  assert.equal(manualRoot, "/work/manual-service");
  assert.equal(routeRequests.length, 1);

  element("project-root").value = "";
  routeDecision = "multiple";
  await assert.rejects(
    vm.runInContext(`resolveProjectRootForQuery("FlowSwitcher")`, context),
    /多个项目/,
  );
  const routeStatusHtml = element("project-route-status").innerHTML;
  assert.match(routeStatusHtml, /\/work\/change-service/);
  assert.match(routeStatusHtml, /\/work\/refund-service/);
  assert.doesNotMatch(routeStatusHtml, /\/work\/observer-service/);
  assert.equal(vm.runInContext(`getProjectRootPath()`, context), "");
  vm.runInContext(`selectProjectRouteCandidate("/work/refund-service")`, context);
  assert.equal(element("project-root").value, "/work/refund-service");
  assert.equal(storage.get("ace-mcp-selected-project"), "/work/refund-service");
  element("project-root").value = "";
  vm.runInContext(`setSelectedProject("")`, context);

  routeDecision = "single";
  vm.runInContext(`
    qaConversationHistory = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" }
    ];
    qaConversationProjectRoot = "/work/qa-service";
    activeResolvedProjectRootPath = "/work/latest-search-service";
  `, context);
  const routeCountBeforeFollowUp = routeRequests.length;
  const qaFollowUpRoot = await vm.runInContext(`resolveQaProjectRootForQuestion("follow up")`, context);
  assert.equal(qaFollowUpRoot, "/work/qa-service");
  assert.equal(routeRequests.length, routeCountBeforeFollowUp);
  assert.equal(vm.runInContext(`qaConversationHistory.length`, context), 2);
  assert.equal(storage.get("ace-mcp-qa-history-project"), "/work/qa-service");

  element("project-root").value = "/work/manual-service";
  const manualQaRoot = await vm.runInContext(`resolveQaProjectRootForQuestion("manual follow up")`, context);
  assert.equal(manualQaRoot, "/work/manual-service");
  assert.equal(vm.runInContext(`qaConversationHistory.length`, context), 0);
  assert.equal(storage.get("ace-mcp-qa-history-project"), "/work/manual-service");

  element("project-root").value = "";
  vm.runInContext(`
    qaConversationHistory = [
      { role: "user", content: "legacy question" },
      { role: "assistant", content: "legacy answer" }
    ];
    qaConversationProjectRoot = "";
    activeResolvedProjectRootPath = "/work/latest-search-service";
  `, context);
  const routeCountBeforeLegacyHistory = routeRequests.length;
  const migratedQaRoot = await vm.runInContext(`resolveQaProjectRootForQuestion("FlowSwitcher follow up")`, context);
  assert.equal(migratedQaRoot, "/work/change-service");
  assert.equal(routeRequests.length, routeCountBeforeLegacyHistory + 1);
  assert.equal(vm.runInContext(`qaConversationHistory.length`, context), 0);
  assert.equal(storage.get("ace-mcp-qa-history-project"), "/work/change-service");
});

test("CLI bin entrypoint is directly executable after global npm install", () => {
  const entrypoint = readFileSync(path.join(rootDir, "src/index.ts"), "utf8");

  assert.match(entrypoint, /^#!\/usr\/bin\/env node\r?\n/);
});

test("Web runtime starts and stops automatic index updates", () => {
  const entrypoint = readFileSync(path.join(rootDir, "src/index.ts"), "utf8");

  assert.match(entrypoint, /if \(shouldStartAutomaticUpdates\(cliOptions\)\) \{[\s\S]*startAutomaticUpdates\(\)/);
  assert.match(entrypoint, /shutdown[\s\S]*stopAutomaticUpdates\(\)/);
});

test("CLI warmup completes before service readiness and routes semantic writes through the coordinator", () => {
  const entrypoint = readFileSync(path.join(rootDir, "src/index.ts"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const awaitedWarmup = entrypoint.indexOf("await warmupKnownProjects(");
  const webStart = entrypoint.indexOf("await startWebApp(");
  const mcpStart = entrypoint.indexOf("await server.connect(");
  const currentReadmeRelease = readme.match(/### v4\.10\.3[\s\S]*?(?=### v4\.10\.2)/)?.[0] ?? "";
  const historicalReadmeRelease = readme.match(/### v4\.6\.4[\s\S]*?(?=### v4\.6\.3)/)?.[0] ?? "";
  const currentChangelogRelease = changelog.match(/## \[4\.10\.3\][\s\S]*?(?=## \[4\.10\.2\])/)?.[0] ?? "";

  assert.ok(awaitedWarmup >= 0, "warmup is not awaited");
  assert.ok(awaitedWarmup < webStart, "Web starts before warmup completes");
  assert.ok(awaitedWarmup < mcpStart, "MCP starts before warmup completes");
  assert.doesNotMatch(entrypoint, /store\.ensureSemanticIndex\(project\.projectId\)/);
  assert.match(entrypoint, /await indexCoordinator\.ensureSemanticIndex\(project\.projectId\)/);
  assert.match(entrypoint, /projectStats\.status !== "ready"/);
  assert.match(entrypoint, /!event \|\| event\.failedFileCount > 0/);
  assert.match(currentReadmeRelease, /`--warm`/);
  assert.match(currentReadmeRelease, /readiness 前完成暖机/);
  assert.match(currentReadmeRelease, /Coordinator 管理的 SQLite worker/);
  assert.match(currentReadmeRelease, /LaunchAgent 默认不启用 `--warm`/);
  assert.match(historicalReadmeRelease, /服务启动后异步暖机/);
  assert.match(historicalReadmeRelease, /暖机完全异步、不阻塞 MCP\/Web 可用性/);
  assert.match(currentChangelogRelease, /`--warm`/);
  assert.match(currentChangelogRelease, /readiness 前/);
  assert.match(currentChangelogRelease, /coordinator-owned SQLite worker/);
  assert.match(currentChangelogRelease, /LaunchAgent 默认不启用/);
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

test("Windows zip release tooling builds a self-contained runtime", () => {
  const packageScriptPath = path.join(rootDir, "scripts/package-windows.mjs");
  const copyStaticScriptPath = path.join(rootDir, "scripts/copy-web-static.mjs");
  const smokeScriptPath = path.join(rootDir, "scripts/smoke-release.mjs");
  const benchmarkScriptPath = path.join(rootDir, "scripts/benchmark-search.mjs");
  const verifyAssetsScriptPath = path.join(rootDir, "scripts/verify-release-assets.mjs");
  const checkSecretsScriptPath = path.join(rootDir, "scripts/check-secrets.mjs");
  const publishScriptPath = path.join(rootDir, "scripts/publish-gitee-release.mjs");
  const reindexScriptPath = path.join(rootDir, "scripts/reindex-projects.mjs");

  assert.equal(existsSync(packageScriptPath), true);
  assert.equal(existsSync(copyStaticScriptPath), true);
  assert.equal(existsSync(smokeScriptPath), true);
  assert.equal(existsSync(benchmarkScriptPath), true);
  assert.equal(existsSync(verifyAssetsScriptPath), true);
  assert.equal(existsSync(checkSecretsScriptPath), true);
  assert.equal(existsSync(publishScriptPath), true);
  assert.equal(existsSync(reindexScriptPath), true);

  const packageScript = readFileSync(packageScriptPath, "utf8");
  const copyStaticScript = readFileSync(copyStaticScriptPath, "utf8");
  const smokeScript = readFileSync(smokeScriptPath, "utf8");
  const benchmarkScript = readFileSync(benchmarkScriptPath, "utf8");
  const verifyAssetsScript = readFileSync(verifyAssetsScriptPath, "utf8");
  const checkSecretsScript = readFileSync(checkSecretsScriptPath, "utf8");
  const publishScript = readFileSync(publishScriptPath, "utf8");
  const reindexScript = readFileSync(reindexScriptPath, "utf8");

  assert.match(packageScript, /ace-mcp-v\$\{version\}-win-x64/);
  assert.match(packageScript, /\$\{packageName\}\.zip/);
  assert.match(packageScript, /README-WINDOWS\.md/);
  assert.match(packageScript, /process\.execPath/);
  assert.match(packageScript, /runtime["', ]+node\.exe/);
  assert.match(packageScript, /node_modules/);
  assert.match(packageScript, /npm prune --omit=dev/);
  assert.match(packageScript, /nodeMajor !== 22/);
  assert.match(packageScript, /better_sqlite3\.node/);
  assert.match(packageScript, /bundled better-sqlite3 probe/);
  assert.match(packageScript, /ace-mcp\.cmd/);
  assert.match(packageScript, /ace-mcp-web\.cmd/);
  assert.match(packageScript, /no installation or npm download is required/);
  assert.match(packageScript, /install\.ps1/);
  assert.match(packageScript, /start-web\.cmd/);
  assert.match(packageScript, /scripts\/reindex-projects\.mjs/);
  assert.match(copyStaticScript, /cpSync/);
  assert.match(copyStaticScript, /src["', ]+web["', ]+static/);
  assert.match(copyStaticScript, /dist["', ]+web["', ]+static/);
  assert.match(smokeScript, /npm install/);
  assert.match(smokeScript, /ace-mcp --version/);
  assert.match(smokeScript, /ace-mcp-web/);
  assert.match(smokeScript, /Windows ace-mcp --doctor without Node\/npm on PATH/);
  assert.match(smokeScript, /self-contained Windows ace-mcp-web/);
  assert.match(smokeScript, /better_sqlite3\.node/);
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
});

test("macOS quick install script and docs are packaged for one-command setup", () => {
  const installScriptPath = path.join(rootDir, "scripts/install-macos.sh");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const checklist = readFileSync(path.join(rootDir, "docs/release-checklist.md"), "utf8");

  assert.equal(existsSync(installScriptPath), true);

  const installScript = readFileSync(installScriptPath, "utf8");
  assert.match(installScript, /^#!\/usr\/bin\/env bash\r?\n/);
  assert.match(installScript, /set -euo pipefail/);
  assert.match(installScript, /ACE_MCP_VERSION/);
  assert.match(installScript, /curl -fL/);
  assert.match(installScript, /gitee\.com\/AndrewFengCode\/ace-mcp\/releases\/download\/v/);
  assert.match(installScript, /npm install -g/);
  assert.match(installScript, /ace-mcp --doctor/);
  assert.match(installScript, /brew install node@22/);

  assert.match(readme, /### macOS 一键安装/);
  assert.match(installScript, /ACE_MCP_VERSION="\$\{ACE_MCP_VERSION:-4\.10\.5\}"/);
  assert.match(readme, /bash -c "\$\(curl -fsSL https:\/\/gitee\.com\/AndrewFengCode\/ace-mcp\/raw\/v4\.10\.5\/scripts\/install-macos\.sh\)"/);
  assert.match(readme, /依赖需求清单/);
  assert.match(readme, /Node\.js >=18\.18\.0/);
  assert.match(readme, /npm/);
  assert.match(readme, /curl/);
  assert.match(readme, /Xcode Command Line Tools/);
  assert.match(readme, /Homebrew/);
  assert.match(readme, /ACE_MCP_VERSION=4\.10\.5/);

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

  assert.match(readme, /npm run release:verify-assets -- --version 4\.10\.5/);
  assert.match(readme, /raw\/v4\.10\.5\/scripts\/install-macos\.sh/);
  assert.doesNotMatch(readme, /raw\/master\/scripts\/install-macos\.sh/);

  assert.match(checklist, /npm run release:verify-assets -- --version 4\.10\.5/);
  assert.match(checklist, /ace-mcp-4\.10\.5\.tgz/);
  assert.match(checklist, /ace-mcp-v4\.10\.5-win-x64\.zip/);
  assert.match(checklist, /tar -tf ace-mcp-4\.10\.5\.tgz > \/tmp\/ace-mcp-tgz-files\.txt/);
  assert.match(checklist, /rg -Fx "package\/dist\/web\/static\/js\/app\.js" \/tmp\/ace-mcp-tgz-files\.txt/);
  assert.match(checklist, /rg -Fx "package\/dist\/web\/static\/css\/main\.css" \/tmp\/ace-mcp-tgz-files\.txt/);
  assert.match(checklist, /unzip -Z1 release\/ace-mcp-v4\.10\.5-win-x64\.zip > \/tmp\/ace-mcp-win-files\.txt/);
  assert.match(checklist, /rg -Fx "ace-mcp-v4\.10\.5-win-x64\/dist\/web\/static\/js\/app\.js" \/tmp\/ace-mcp-win-files\.txt/);
  assert.match(checklist, /rg -Fx "ace-mcp-v4\.10\.5-win-x64\/dist\/web\/static\/css\/main\.css" \/tmp\/ace-mcp-win-files\.txt/);
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

  assert.match(readme, /npm run release:publish -- --version 4\.10\.5/);
  assert.match(readme, /GITEE_TOKEN/);
  assert.match(readme, /release:verify-assets/);

  assert.match(checklist, /npm run release:publish -- --version 4\.10\.5/);
  assert.match(checklist, /GITEE_TOKEN/);
});

test("Windows README documents zip installation and MCP client command paths", () => {
  const windowsReadme = readFileSync(path.join(rootDir, "scripts/README-WINDOWS.md"), "utf8");

  assert.match(windowsReadme, /ace-mcp-v4\.10\.5-win-x64\.zip/);
  assert.match(windowsReadme, /reindex-projects\.mjs/);
  assert.match(windowsReadme, /start-web\.cmd/);
  assert.match(windowsReadme, /ace-mcp\.cmd/);
  assert.match(windowsReadme, /better-sqlite3/);
  assert.match(windowsReadme, /Node\.js.*npm.*Visual Studio Build Tools/);
  assert.match(windowsReadme, /doctor\.cmd/);
});

test("release checklist records the v4.10.5 verification gates", () => {
  const checklist = readFileSync(path.join(rootDir, "docs/release-checklist.md"), "utf8");

  assert.match(checklist, /v4\.10\.5/);
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
  assert.match(checklist, /git tag -a v4\.10\.5/);
});

test("v4.10.5 release docs describe stable Git dirty reconciliation", () => {
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(readme, /当前版本：`v4\.10\.5`/);
  assert.match(readme, /### v4\.10\.5（当前版本）/);
  assert.match(readme, /dirty.*untracked.*文件指纹/s);
  assert.match(changelog, /## \[4\.10\.5\] - 2026-08-11/);
  assert.match(changelog, /dirty.*untracked.*文件指纹/s);
  assert.match(roadmap, /Git dirty.*重复索引.*v4\.10\.5/);
});

test("v4.10.4 release docs describe bounded logging without claiming unfinished Windows artifacts", () => {
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");
  const checklist = readFileSync(path.join(rootDir, "docs/release-checklist.md"), "utf8");
  const windowsReadme = readFileSync(path.join(rootDir, "scripts/README-WINDOWS.md"), "utf8");

  assert.match(readme, /当前版本：`v4\.10\.5`/);
  assert.match(readme, /### v4\.10\.4/);
  assert.match(readme, /20 MiB/);
  assert.match(readme, /EPIPE/);
  assert.match(readme, /ownership 锚点/);

  assert.match(changelog, /## \[4\.10\.4\] - 2026-08-03/);
  assert.match(changelog, /Bounded and failure-safe logging/);
  assert.match(changelog, /stderr EPIPE/);
  assert.match(changelog, /Mixed-term project routing ownership/);
  assert.match(roadmap, /有界且异常安全的日志.*v4\.10\.4/);
  assert.match(roadmap, /混合业务词项目归属.*v4\.10\.4/);

  assert.match(checklist, /--during-index/);
  assert.match(checklist, /至少 20 个.*\/health.*至少 20 个.*\/api\/projects\/resolve/s);
  assert.match(checklist, /Windows x64 \+ Node\.js 22/);
  assert.match(checklist, /尚未.*Windows ZIP/);
  assert.match(windowsReadme, /必须在 Windows x64 \+ Node\.js 22/);
  assert.match(windowsReadme, /尚待.*Windows.*构建.*验证/);
});

test("runtime data health diagnostics are exposed by health and project profile", () => {
  const dataHealth = readFileSync(path.join(rootDir, "src/web/dataHealth.ts"), "utf8");
  const metaRoutes = readFileSync(path.join(rootDir, "src/web/routes/metaRoutes.ts"), "utf8");
  const profileRoutes = readFileSync(path.join(rootDir, "src/web/routes/projectProfileRoutes.ts"), "utf8");
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const appTest = readFileSync(path.join(rootDir, "src/web/app.test.ts"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(dataHealth, /DataHealthStatus = "ok" \| "degraded" \| "repairable"/);
  assert.match(dataHealth, /PROJECT_PATH_MISSING/);
  assert.match(dataHealth, /PROJECT_LIST_UNAVAILABLE/);
  assert.match(dataHealth, /PROJECT_STATS_UNAVAILABLE/);
  assert.match(dataHealth, /CHECK_PROJECT_PATH/);
  assert.match(dataHealth, /RUN_DOCTOR/);
  assert.match(dataHealth, /RUN_FULL_INDEX/);
  assert.match(metaRoutes, /dataHealth: buildProjectListDataHealth\(projects\)/);
  assert.match(metaRoutes, /PROJECT_LIST_UNAVAILABLE/);
  assert.match(profileRoutes, /dataHealth/);
  assert.match(profileRoutes, /needs_repair/);
  assert.match(profileRoutes, /PROJECT_STATS_UNAVAILABLE/);
  assert.match(profileRoutes, /PROJECT_VECTOR_UNAVAILABLE/);
  assert.match(profileRoutes, /PROJECT_FILES_UNAVAILABLE/);
  assert.match(appJs, /function formatDataHealthStatus\(/);
  assert.match(appJs, /数据健康/);
  assert.match(appJs, /data-health-suggestions/);
  assert.match(appJs, /CHECK_PROJECT_PATH: "检查路径"/);
  assert.match(appJs, /RUN_DOCTOR: "运行自检"/);
  assert.match(appTest, /health reports runtime data health for missing registered project paths/);
  assert.match(appTest, /health degrades data health when project listing fails/);
  assert.match(appTest, /project profile reports repairable data health when indexed project stats fail/);
  assert.match(readme, /当前版本：`v4\.10\.5`/);
  assert.match(readme, /运行时数据健康诊断/);
  assert.match(readme, /dataHealth/);
  assert.match(changelog, /Runtime data health diagnostics/);
  assert.match(roadmap, /运行时数据健康诊断/);
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
  assert.match(readme, /当前版本：`v4\.10\.5`/);
  assert.match(readme, /项目级搜索画像/);
  assert.match(readme, /\/api\/project-profile/);
  assert.match(changelog, /## \[4\.9\.1\]/);
  assert.match(changelog, /Project search profile diagnostics/);
  assert.match(roadmap, /项目级搜索画像/);
  assert.match(roadmap, /v4\.9\.1/);
});

test("web project profile suggestions provide one-click repair actions", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(appJs, /data-profile-fix="\$\{escapeHtmlAttribute\(suggestion\.code\)\}"/);
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
  assert.match(appJs, /data-copy-path="\$\{escapeHtmlAttribute\(filePath\)\}"/);
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

test("web dynamic renderers preserve hostile attribute values without creating event handlers", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const decodeAttribute = (value: string) => value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  const parseNodes = (html: string) => {
    const nodes: any[] = [];
    for (const tagMatch of html.matchAll(/<([a-z][\w-]*)([^<>]*?)>/gi)) {
      const attributes = new Map<string, string>();
      const attributePattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
      for (const match of tagMatch[2].matchAll(attributePattern)) {
        const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
        attributes.set(match[1].toLowerCase(), decodeAttribute(rawValue));
      }
      const listeners = new Map<string, Array<() => void>>();
      const dataset: Record<string, string> = {};
      for (const [name, value] of attributes) {
        if (!name.startsWith("data-")) continue;
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        dataset[key] = value;
      }
      nodes.push({
        attributes,
        dataset,
        addEventListener(type: string, handler: () => void) {
          listeners.set(type, [...(listeners.get(type) || []), handler]);
        },
        click() {
          for (const handler of listeners.get("click") || []) handler();
        },
        getAttribute(name: string) {
          return attributes.get(name.toLowerCase()) ?? null;
        },
      });
    }
    return nodes;
  };
  const matchesSelector = (node: any, selector: string) => {
    if (selector.startsWith(".")) {
      return (node.getAttribute("class") || "").split(/\s+/).includes(selector.slice(1));
    }
    const attributeMatch = selector.match(/^\[([^\]]+)\]$/);
    return attributeMatch ? node.getAttribute(attributeMatch[1]) !== null : false;
  };
  const makeElement = () => {
    let html = "";
    let nodes: any[] = [];
    const node: any = {
      checked: false,
      classList: { add() {}, remove() {}, toggle() { return false; } },
      click() {},
      dataset: {},
      disabled: false,
      hidden: false,
      options: [{ text: "" }],
      parentElement: null,
      selectedIndex: 0,
      style: {},
      value: "",
      addEventListener() {},
      append() {},
      appendChild() {},
      focus() {},
      getAttribute() { return null; },
      querySelector(selector: string) {
        return nodes.find((item) => matchesSelector(item, selector)) || null;
      },
      querySelectorAll(selector: string) {
        return nodes.filter((item) => matchesSelector(item, selector));
      },
      remove() {},
      select() {},
      setAttribute() {},
    };
    Object.defineProperty(node, "innerHTML", {
      configurable: true,
      get() { return html; },
      set(value) {
        html = String(value);
        nodes = parseNodes(html);
      },
    });
    Object.defineProperty(node, "textContent", {
      configurable: true,
      get() { return html; },
      set(value) {
        html = String(value ?? "");
        nodes = [];
      },
    });
    return node;
  };
  const makeEscapingElement = () => {
    let html = "";
    return {
      get innerHTML() { return html; },
      set innerHTML(value) { html = String(value); },
      get textContent() { return decodeAttribute(html); },
      set textContent(value) {
        html = String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      },
    };
  };
  const makeSelect = () => {
    let value = "";
    let html = "";
    const select: any = makeElement();
    Object.defineProperty(select, "innerHTML", {
      configurable: true,
      get() { return html; },
      set(nextHtml) {
        html = String(nextHtml);
        select.optionNodes = parseNodes(html)
          .filter((option) => option.getAttribute("value") !== null);
        select.options = select.optionNodes
          .map((option: any) => ({ text: "", value: option.getAttribute("value") }));
      },
    });
    Object.defineProperty(select, "value", {
      configurable: true,
      get() { return value; },
      set(nextValue) {
        const index = select.options.findIndex((option: { value: string }) => option.value === String(nextValue));
        value = index >= 0 ? String(nextValue) : "";
        select.selectedIndex = Math.max(0, index);
      },
    });
    return select;
  };

  const dangerousProject = `/work/quote'" onmouseover="globalThis.__projectPwned=1`;
  const dangerousTaskId = `task-'" onmouseover="globalThis.__taskPwned=1`;
  const dangerousStatus = `failed-'" onmouseover="globalThis.__statusPwned=1`;
  const dangerousCode = `RUN_FULL_INDEX-'" onmouseover="globalThis.__profilePwned=1`;
  const dangerousFile = `/work/src/file-'" onmouseover="globalThis.__filePwned=1.ts`;
  const dangerousLanguage = `ts-'" onmouseover="globalThis.__languagePwned=1`;
  const elements = new Map<string, any>();
  elements.set("project-root", makeElement());
  elements.set("project-root-select", makeSelect());
  elements.set("project-route-status", makeElement());
  elements.set("task-list", makeElement());
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  const storage = new Map<string, string>();
  const context = vm.createContext({
    AbortController,
    alert() {},
    clearInterval() {},
    clearTimeout,
    confirm() { return false; },
    console,
    document: {
      addEventListener() {},
      body: element("body"),
      createElement() { return makeEscapingElement(); },
      execCommand() { return true; },
      getElementById(id: string) { return element(id); },
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
      getItem(key: string) { return storage.get(key) || null; },
      removeItem(key: string) { storage.delete(key); },
      setItem(key: string, value: string) { storage.set(key, value); },
    },
    navigator: {},
    setInterval() { return 1; },
    setTimeout,
    URLSearchParams,
    window: { confirm() { return false; }, isSecureContext: false, location: { href: "" } },
  });

  vm.runInContext(appJs, context);
  vm.runInContext(`renderProjectRouteStatus({
    decision: "multiple",
    selectedProjectRootPaths: [${JSON.stringify(dangerousProject)}],
    candidates: [{ projectRootPath: ${JSON.stringify(dangerousProject)}, confidence: 1 }]
  })`, context);
  const candidate = element("project-route-status").querySelector("[data-project-route-candidate]");
  assert.ok(candidate);
  assert.equal(candidate.getAttribute("onmouseover"), null);
  assert.equal(candidate.dataset.projectRouteCandidate, dangerousProject);
  candidate.click();
  assert.equal(storage.get("ace-mcp-selected-project"), dangerousProject);
  assert.equal(JSON.parse(storage.get("ace-mcp-projects") || "[]")[0]?.path, dangerousProject);
  const selectedOption = element("project-root-select").optionNodes
    .find((option: any) => option.getAttribute("value") === dangerousProject);
  assert.ok(selectedOption);
  assert.equal(selectedOption.getAttribute("onmouseover"), null);
  assert.equal(element("project-root-select").value, dangerousProject);
  assert.equal(element("project-root").value, dangerousProject);

  vm.runInContext(`renderTaskCenter([
    { taskId: ${JSON.stringify(dangerousTaskId)}, projectRootPath: ${JSON.stringify(dangerousProject)}, status: "running", type: "index" },
    { taskId: "finished", projectRootPath: "/work/safe", status: ${JSON.stringify(dangerousStatus)}, type: "index" }
  ])`, context);
  const cancelButton = element("task-list").querySelector(".task-cancel");
  assert.equal(cancelButton.getAttribute("onmouseover"), null);
  assert.equal(cancelButton.dataset.taskId, dangerousTaskId);
  const taskProject = element("task-list").querySelector(".task-project");
  assert.equal(taskProject.getAttribute("onmouseover"), null);
  assert.equal(taskProject.getAttribute("title"), dangerousProject);
  const taskStatuses = element("task-list").querySelectorAll(".task-status");
  assert.equal(taskStatuses[1].getAttribute("onmouseover"), null);
  assert.match(taskStatuses[1].getAttribute("class"), new RegExp(dangerousStatus.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const profileHtml = vm.runInContext(`renderProjectProfileSummary({
    diagnostics: { suggestions: [{ code: ${JSON.stringify(dangerousCode)}, severity: ${JSON.stringify(dangerousStatus)}, label: "repair" }] },
    dataHealth: { suggestions: [{ code: "RUN_DOCTOR", severity: ${JSON.stringify(dangerousStatus)}, label: "doctor" }] }
  })`, context) as string;
  const profileNodes = parseNodes(profileHtml);
  const profileButton = profileNodes.find((node) => matchesSelector(node, ".profile-fix-action"));
  assert.equal(profileButton.getAttribute("onmouseover"), null);
  assert.equal(profileButton.dataset.profileFix, dangerousCode);
  for (const suggestion of profileNodes.filter((node) => matchesSelector(node, ".diagnostic-suggestion"))) {
    assert.equal(suggestion.getAttribute("onmouseover"), null);
  }

  const failedFilesHtml = vm.runInContext(
    `renderFailedFileDetails([${JSON.stringify(dangerousFile)}], "/work")`,
    context,
  ) as string;
  const failedFileNodes = parseNodes(failedFilesHtml);
  const failedFilePath = failedFileNodes.find((node) => matchesSelector(node, ".failed-file-path"));
  const copyPathButton = failedFileNodes.find((node) => matchesSelector(node, ".copy-failed-file-path"));
  assert.equal(failedFilePath.getAttribute("onmouseover"), null);
  assert.equal(failedFilePath.getAttribute("title"), dangerousFile);
  assert.equal(copyPathButton.getAttribute("onmouseover"), null);
  assert.equal(copyPathButton.dataset.copyPath, dangerousFile);

  const sourceCardHtml = vm.runInContext(`renderSourceCard({
    index: 1,
    score: 1,
    language: ${JSON.stringify(dangerousLanguage)},
    snippet: "const value = 1;",
    startLine: 1,
    endLine: 1,
    filePath: "src/example.ts"
  }, 1)`, context) as string;
  const sourceCardNodes = parseNodes(sourceCardHtml);
  const languageBadge = sourceCardNodes.find((node) => matchesSelector(node, ".qa-source-badge"));
  assert.equal(languageBadge.getAttribute("onmouseover"), null);
  assert.match(
    languageBadge.getAttribute("class"),
    new RegExp(dangerousLanguage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  assert.doesNotMatch(appJs, /\b(?:class|data-[\w-]+|title|value)="[^"]*\$\{escapeHtml\(/);
  assert.match(appJs, /class="qa-source-badge \$\{escapeHtmlAttribute\(langClass\)\}"/);
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

test("web project delete control removes registered project through the API", () => {
  const html = readFileSync(path.join(rootDir, "src/web/static/index.html"), "utf8");
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");

  assert.match(html, /id="delete-project"/);
  assert.match(html, /移除项目登记并清理索引数据/);
  assert.match(appJs, /async function deleteRegisteredProject\(projectPath\)/);
  assert.match(appJs, /request\("DELETE", "\/api\/projects\?projectRootPath=" \+ encodeURIComponent\(projectPath\)\)/);
  assert.match(appJs, /确定要移除此项目登记并清理索引数据吗/);
  assert.match(appJs, /await deleteRegisteredProject\(projectPath\)/);
  assert.match(appJs, /await loadProjects\(\)/);
  assert.match(appJs, /已移除项目登记并清理索引数据/);
  assert.doesNotMatch(appJs, /索引数据会保留在磁盘上/);
});

test("web search and QA results expose IDE and agent jump actions", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const css = readFileSync(path.join(rootDir, "src/web/static/css/main.css"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(appJs, /function getProjectRootPath\(/);
  assert.match(appJs, /function joinSourcePath\(/);
  assert.match(appJs, /function formatSourceAbsolutePath\(/);
  assert.match(appJs, /function buildIdeDeepLink\(/);
  assert.match(appJs, /function buildAgentPrompt\(/);
  assert.match(appJs, /function bindSearchIdeActions\(/);
  assert.match(appJs, /data-copy-kind="absolute"/);
  assert.match(appJs, /data-copy-kind="codex"/);
  assert.match(appJs, /data-copy-kind="claude"/);
  assert.match(appJs, /data-ide-kind="vscode"/);
  assert.match(appJs, /data-ide-kind="idea"/);
  assert.match(appJs, /data-source-absolute-path="\$\{escapeHtmlAttribute\(absolutePath\)\}"/);
  assert.match(appJs, /data-agent-prompt="\$\{escapeHtmlAttribute\(buildAgentPrompt\(source, "codex"\)\)\}"/);
  assert.match(appJs, /data-agent-prompt="\$\{escapeHtmlAttribute\(buildAgentPrompt\(source, "claude"\)\)\}"/);
  assert.match(appJs, /window\.location\.href = url/);
  assert.match(appJs, /bindSearchIdeActions\(\)/);
  assert.doesNotMatch(appJs, /data-ide-kind="cursor"/i);
  assert.doesNotMatch(appJs, /Cursor/);
  assert.match(css, /\.search-result-ide-action/);
  assert.match(readme, /IDE \/ Agent 定位闭环/);
  assert.match(readme, /打开 IDEA/);
  assert.match(readme, /发送到 Codex/);
  assert.match(readme, /发送到 Claude/);
  assert.match(changelog, /IDE \/ Agent jump actions/);
  assert.match(roadmap, /IDE \/ Agent 定位闭环/);
});

test("web source actions retain their producing project root", () => {
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
  const inputs = new Map<string, ReturnType<typeof element>>();
  const projectRoot = element();
  projectRoot.value = "/repo/app";
  inputs.set("project-root", projectRoot);
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
      getElementById(id: string) { return inputs.get(id) || element(); },
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
    window: { confirm() { return false; }, isSecureContext: false, location: { href: "" } },
  });

  vm.runInContext(appJs, context);
  const absolutePath = vm.runInContext(`formatSourceAbsolutePath({
    filePath: "src/example.ts",
    startLine: 7,
    endLine: 9,
    snippet: "const answer = 42;"
  })`, context) as string;
  const vscodeUrl = vm.runInContext(`buildIdeDeepLink({
    filePath: "src/example.ts",
    startLine: 7,
    endLine: 9,
    snippet: "const answer = 42;"
  }, "vscode")`, context) as string;
  const ideaUrl = vm.runInContext(`buildIdeDeepLink({
    filePath: "src/example.ts",
    startLine: 7,
    endLine: 9,
    snippet: "const answer = 42;"
  }, "idea")`, context) as string;
  const codexPrompt = vm.runInContext(`buildAgentPrompt({
    filePath: "src/example.ts",
    startLine: 7,
    endLine: 9,
    snippet: "const answer = 42;"
  }, "codex")`, context) as string;
  const claudePrompt = vm.runInContext(`buildAgentPrompt({
    filePath: "src/example.ts",
    startLine: 7,
    endLine: 9,
    snippet: "const answer = 42;"
  }, "claude")`, context) as string;
  const actionsHtml = vm.runInContext(`renderSearchResultActions({
    filePath: "src/example.ts",
    startLine: 7,
    endLine: 9,
    snippet: "const answer = 42;"
  })`, context) as string;

  assert.equal(absolutePath, "/repo/app/src/example.ts");
  assert.equal(vscodeUrl, "vscode://file//repo/app/src/example.ts:7");
  assert.match(ideaUrl, /^jetbrains:\/\/idea\/navigate\/reference\?/);
  assert.match(ideaUrl, /project=%2Frepo%2Fapp/);
  assert.match(ideaUrl, /path=%2Frepo%2Fapp%2Fsrc%2Fexample\.ts/);
  assert.match(ideaUrl, /line=7/);
  assert.match(codexPrompt, /Codex/);
  assert.match(codexPrompt, /\/repo\/app\/src\/example\.ts:7/);
  assert.match(codexPrompt, /const answer = 42;/);
  assert.match(claudePrompt, /Claude Code/);
  assert.match(claudePrompt, /\/repo\/app\/src\/example\.ts:7/);
  assert.match(actionsHtml, /复制绝对路径/);
  assert.match(actionsHtml, /打开 VS Code/);
  assert.match(actionsHtml, /打开 IDEA/);
  assert.match(actionsHtml, /发送到 Codex/);
  assert.match(actionsHtml, /发送到 Claude/);
  assert.doesNotMatch(actionsHtml, /Cursor/i);

  projectRoot.value = "/repo/later-manual-selection";
  const boundActions = vm.runInContext(`(() => {
    const searchResponse = bindSearchResponseSourcesToProjectRoot({
      data: {
        results: [{
          filePath: "src/search.ts",
          startLine: 11,
          endLine: 13,
          language: "typescript",
          snippet: "export const search = true;"
        }]
      }
    }, "/repo/search-owner");
    const searchSource = searchResponse.data.results[0];
    const qaSource = bindSourcesToProjectRoot([{
      filePath: "src/qa.ts",
      startLine: 21,
      endLine: 23,
      language: "typescript",
      snippet: "export const qa = true;"
    }], "/repo/qa-owner")[0];
    activeResolvedProjectRootPath = "/repo/later-auto-selection";
    return {
      searchProjectRoot: searchSource.projectRootPath,
      qaProjectRoot: qaSource.projectRootPath,
      absolutePath: formatSourceAbsolutePath(searchSource),
      vscodeUrl: buildIdeDeepLink(searchSource, "vscode"),
      ideaUrl: buildIdeDeepLink(searchSource, "idea"),
      agentPrompt: buildAgentPrompt(searchSource, "codex"),
      actionsHtml: renderSearchResultActions(searchSource),
      lazyHtml: renderLazyContextAction(searchSource),
      serializedProjectRoot: JSON.parse(serializeSourceForBundle(searchSource)).projectRootPath,
      bundleMarkdown: buildContextBundleMarkdown([qaSource], "codex")
    };
  })()`, context) as Record<string, string>;

  assert.equal(boundActions.searchProjectRoot, "/repo/search-owner");
  assert.equal(boundActions.qaProjectRoot, "/repo/qa-owner");
  assert.equal(boundActions.absolutePath, "/repo/search-owner/src/search.ts");
  assert.equal(boundActions.vscodeUrl, "vscode://file//repo/search-owner/src/search.ts:11");
  assert.match(boundActions.ideaUrl, /project=%2Frepo%2Fsearch-owner/);
  assert.match(boundActions.ideaUrl, /path=%2Frepo%2Fsearch-owner%2Fsrc%2Fsearch\.ts/);
  assert.match(boundActions.agentPrompt, /项目根目录：\/repo\/search-owner/);
  assert.match(boundActions.agentPrompt, /\/repo\/search-owner\/src\/search\.ts:11/);
  assert.match(boundActions.actionsHtml, /data-source-absolute-path="\/repo\/search-owner\/src\/search\.ts"/);
  assert.match(boundActions.lazyHtml, /data-context-project-root-path="\/repo\/search-owner"/);
  assert.equal(boundActions.serializedProjectRoot, "/repo/search-owner");
  assert.match(boundActions.bundleMarkdown, /项目根目录：\/repo\/qa-owner/);
  assert.match(boundActions.bundleMarkdown, /\/repo\/qa-owner\/src\/qa\.ts:21/);
  assert.doesNotMatch(boundActions.bundleMarkdown, /later-(?:manual|auto)-selection/);
});

test("web search and QA results expose selected context bundle actions", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const css = readFileSync(path.join(rootDir, "src/web/static/css/main.css"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(appJs, /function serializeSourceForBundle\(/);
  assert.match(appJs, /function renderSourceBundleSelector\(/);
  assert.match(appJs, /function renderContextBundleToolbar\(/);
  assert.match(appJs, /function collectSelectedBundleSources\(/);
  assert.match(appJs, /function buildContextBundleMarkdown\(/);
  assert.match(appJs, /function bindContextBundleActions\(/);
  assert.match(appJs, /data-bundle-source=/);
  assert.match(appJs, /data-context-bundle-action="copy"/);
  assert.match(appJs, /data-context-bundle-agent="codex"/);
  assert.match(appJs, /data-context-bundle-agent="claude"/);
  assert.match(appJs, /renderContextBundleToolbar\("search"\)/);
  assert.match(appJs, /renderContextBundleToolbar\("qa"\)/);
  assert.match(appJs, /renderSourceBundleSelector\(item, `search-\$\{index\}`\)/);
  assert.match(appJs, /renderSourceBundleSelector\(source, `qa-\$\{source\.index/);
  assert.match(appJs, /bindContextBundleActions\(\)/);
  assert.match(appJs, /copyTextToClipboard\(markdown, button\)/);
  assert.match(css, /\.context-bundle-toolbar/);
  assert.match(css, /\.source-bundle-selector/);
  assert.match(readme, /结果上下文打包/);
  assert.match(readme, /复制上下文包/);
  assert.match(readme, /多文件交接/);
  assert.match(changelog, /Result context bundle/);
  assert.match(roadmap, /结果上下文打包/);
});

test("web context bundle exposes editable task draft controls", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const css = readFileSync(path.join(rootDir, "src/web/static/css/main.css"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(appJs, /const CONTEXT_BUNDLE_TASK_PRESETS = \[/);
  assert.match(appJs, /解释这段逻辑/);
  assert.match(appJs, /找潜在 bug/);
  assert.match(appJs, /生成修改方案/);
  assert.match(appJs, /补测试/);
  assert.match(appJs, /function getContextBundleTaskDraft\(/);
  assert.match(appJs, /function applyContextBundleTaskPreset\(/);
  assert.match(appJs, /data-context-bundle-task/);
  assert.match(appJs, /data-context-bundle-preset/);
  assert.match(css, /\.context-bundle-task/);
  assert.match(css, /\.context-bundle-task-input/);
  assert.match(css, /\.context-bundle-preset/);
  assert.match(readme, /任务草稿/);
  assert.match(readme, /任务说明/);
  assert.match(readme, /补测试/);
  assert.match(changelog, /Editable context bundle task draft/);
  assert.match(roadmap, /上下文包任务草稿/);
});

test("web context bundle preset click is reused by copy and agent bundle actions", async () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const listeners = new Map<string, Array<() => void>>();
  const checkboxAttributes = new Map<string, string>();
  checkboxAttributes.set("data-bundle-source", JSON.stringify({
    filePath: "src/a.ts",
    language: "typescript",
    snippet: "export function search() {}",
    startLine: 3,
  }));
  const copied: string[] = [];
  const makeElement = (attributes: Record<string, string> = {}) => {
    const node = {
      attributes: new Map<string, string>(Object.entries(attributes)),
      checked: false,
      children: [] as any[],
      dataset: {} as Record<string, string>,
      parentElement: null as any,
      style: {},
      textContent: "",
      value: "",
      addEventListener(type: string, handler: () => void) {
        const key = `${attributes.id || attributes.class || attributes["data-context-bundle-preset"] || attributes["data-context-bundle-agent"] || "node"}:${type}`;
        const handlers = listeners.get(key) || [];
        handlers.push(handler);
        listeners.set(key, handlers);
      },
      appendChild(child: any) {
        node.children.push(child);
        child.parentElement = node;
      },
      closest(selector: string) {
        if (selector === ".context-bundle-toolbar") return toolbar;
        return null;
      },
      focus() {},
      getAttribute(name: string) {
        return node.attributes.get(name) || "";
      },
      querySelector(selector: string) {
        if (selector === "[data-context-bundle-task]") return taskInput;
        return null;
      },
      querySelectorAll(_selector?: string): any[] {
        return [];
      },
      removeChild(child: any) {
        node.children = node.children.filter((item) => item !== child);
      },
      select() {},
      setAttribute(name: string, value: string) {
        node.attributes.set(name, value);
      },
    };
    return node;
  };
  const taskInput = makeElement({ "data-context-bundle-task": "1", class: "context-bundle-task-input" });
  const presetButton = makeElement({ "data-context-bundle-preset": "补测试", class: "context-bundle-preset" });
  const copyButton = makeElement({ "data-context-bundle-action": "copy", class: "context-bundle-action" });
  const codexButton = makeElement({ "data-context-bundle-action": "copy", "data-context-bundle-agent": "codex", class: "context-bundle-action" });
  const claudeButton = makeElement({ "data-context-bundle-action": "copy", "data-context-bundle-agent": "claude", class: "context-bundle-action" });
  const checkbox = makeElement({ class: "source-bundle-checkbox" });
  checkbox.checked = true;
  checkbox.getAttribute = (name: string) => checkboxAttributes.get(name) || "";
  const container = makeElement({ class: "search-result-explanations" });
  const toolbar = makeElement({ class: "context-bundle-toolbar" });
  toolbar.parentElement = container;
  container.querySelectorAll = (selector: string) => selector === ".source-bundle-checkbox:checked" ? [checkbox] : [];

  const context = vm.createContext({
    AbortController,
    alert() {},
    clearTimeout,
    confirm() { return false; },
    console,
    document: {
      addEventListener() {},
      body: makeElement({ id: "body" }),
      createElement(tag: string) { return makeElement({ tag }); },
      execCommand() {
        copied.push(context.__lastTextareaValue);
        return true;
      },
      getElementById(id: string) {
        if (id === "project-root") {
          const input = makeElement({ id });
          input.value = "/repo/app";
          return input;
        }
        return makeElement({ id });
      },
      querySelector() { return null; },
      querySelectorAll(selector: string) {
        if (selector === ".context-bundle-preset") return [presetButton];
        if (selector === ".context-bundle-action") return [copyButton, codexButton, claudeButton];
        return [];
      },
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
    window: { confirm() { return false; }, isSecureContext: false, location: { href: "" } },
    __lastTextareaValue: "",
  });
  context.document.body.appendChild = (child: any) => {
    context.__lastTextareaValue = child.value;
    child.parentElement = context.document.body;
  };

  vm.runInContext(appJs, context);
  vm.runInContext(`bindContextBundleActions()`, context);
  presetButton.closest = () => toolbar;
  copyButton.closest = () => toolbar;
  codexButton.closest = () => toolbar;
  claudeButton.closest = () => toolbar;

  listeners.get("context-bundle-preset:click")?.[0]?.();
  assert.equal(taskInput.value, "补测试");
  listeners.get("context-bundle-action:click")?.[0]?.();
  listeners.get("context-bundle-action:click")?.[1]?.();
  listeners.get("context-bundle-action:click")?.[2]?.();

  assert.equal(copied.length, 3);
  assert.match(copied[0], /AI 助手/);
  assert.match(copied[0], /任务说明：补测试/);
  assert.match(copied[1], /Codex/);
  assert.match(copied[1], /任务说明：补测试/);
  assert.match(copied[2], /Claude Code/);
  assert.match(copied[2], /任务说明：补测试/);
  assert.match(copied[2], /\/repo\/app\/src\/a\.ts:3/);
});

test("web search and QA inputs expose reusable query task templates", () => {
  const html = readFileSync(path.join(rootDir, "src/web/static/index.html"), "utf8");
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const css = readFileSync(path.join(rootDir, "src/web/static/css/main.css"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(html, /id="qa-template-buttons"/);
  assert.match(html, /id="search-template-buttons"/);
  assert.match(appJs, /const QUERY_TASK_TEMPLATES = \[/);
  assert.match(appJs, /查调用链/);
  assert.match(appJs, /查影响面/);
  assert.match(appJs, /找潜在 bug/);
  assert.match(appJs, /补单元测试/);
  assert.match(appJs, /梳理业务流程/);
  assert.match(appJs, /function renderQueryTemplateButtons\(/);
  assert.match(appJs, /function applyQueryTemplate\(/);
  assert.match(appJs, /function bindQueryTemplateActions\(/);
  assert.match(appJs, /function mountQueryTemplateButtons\(/);
  assert.match(appJs, /renderQueryTemplateButtons\("qa"\)/);
  assert.match(appJs, /renderQueryTemplateButtons\("search"\)/);
  assert.match(appJs, /bindQueryTemplateActions\(\)/);
  assert.match(css, /\.query-template-panel/);
  assert.match(css, /\.query-template-button/);
  assert.match(readme, /查询\/任务模板/);
  assert.match(readme, /查调用链/);
  assert.match(readme, /补单元测试/);
  assert.match(changelog, /Web query task templates/);
  assert.match(roadmap, /Web 查询\/任务模板/);

  const context = vm.createContext({
    document: {
      addEventListener() {},
      createElement() {
        return {
          innerHTML: "",
          set textContent(value: string) {
            this.innerHTML = String(value)
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;");
          },
        };
      },
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setInterval() { return 1; },
    setTimeout,
    fetch() {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ projects: [], tasks: [] }) });
    },
    console,
    window: { confirm() { return false; }, isSecureContext: false, location: { href: "" } },
    navigator: {},
    URLSearchParams,
    AbortController,
    confirm() { return false; },
    alert() {},
    clearTimeout,
  });
  vm.runInContext(appJs, context);
  const qaHtml = vm.runInContext(`renderQueryTemplateButtons("qa")`, context) as string;
  const searchHtml = vm.runInContext(`renderQueryTemplateButtons("search")`, context) as string;
  assert.match(qaHtml, /data-query-template-target="qa-question"/);
  assert.match(qaHtml, /data-query-template-value="[^"]*调用链/);
  assert.match(searchHtml, /data-query-template-target="search-query"/);
  assert.match(searchHtml, /data-query-template-value="[^"]*symbol:Controller/);
});

test("web query template click fills only the intended input", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const listeners = new Map<string, Array<() => void>>();
  const makeElement = (attributes: Record<string, string> = {}) => {
    const node = {
      attributes: new Map<string, string>(Object.entries(attributes)),
      children: [] as any[],
      dataset: {} as Record<string, string>,
      innerHTML: "",
      style: {},
      textContent: "",
      value: "",
      addEventListener(type: string, handler: () => void) {
        const key = `${attributes.id || attributes["data-query-template-target"] || "node"}:${type}`;
        const handlers = listeners.get(key) || [];
        handlers.push(handler);
        listeners.set(key, handlers);
      },
      appendChild(child: any) {
        node.children.push(child);
        child.parentElement = node;
      },
      focus() {
        node.dataset.focused = "1";
      },
      getAttribute(name: string) {
        return node.attributes.get(name) || "";
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      removeChild(child: any) {
        node.children = node.children.filter((item) => item !== child);
      },
      select() {},
      setAttribute(name: string, value: string) {
        node.attributes.set(name, value);
      },
    };
    return node;
  };
  const qaInput = makeElement({ id: "qa-question" });
  const searchInput = makeElement({ id: "search-query" });
  const qaTemplateButton = makeElement({
    "data-query-template-target": "qa-question",
    "data-query-template-value": "这个方法在哪些入口被调用？请按调用链分层说明。",
  });
  const searchTemplateButton = makeElement({
    "data-query-template-target": "search-query",
    "data-query-template-value": "path:controller OR symbol:Controller",
  });
  const context = vm.createContext({
    AbortController,
    alert() {},
    clearTimeout,
    confirm() { return false; },
    console,
    document: {
      addEventListener() {},
      body: makeElement({ id: "body" }),
      createElement(tag: string) { return makeElement({ tag }); },
      execCommand() { return true; },
      getElementById(id: string) {
        if (id === "qa-question") return qaInput;
        if (id === "search-query") return searchInput;
        return makeElement({ id });
      },
      querySelector() { return null; },
      querySelectorAll(selector: string) {
        if (selector === "[data-query-template-value]") return [qaTemplateButton, searchTemplateButton];
        return [];
      },
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
    window: { confirm() { return false; }, isSecureContext: false, location: { href: "" } },
  });

  vm.runInContext(appJs, context);
  vm.runInContext(`bindQueryTemplateActions()`, context);
  listeners.get("qa-question:click")?.[0]?.();
  assert.match(qaInput.value, /调用链/);
  assert.equal(qaInput.dataset.focused, "1");
  assert.equal(searchInput.value, "");

  listeners.get("search-query:click")?.[0]?.();
  assert.match(searchInput.value, /symbol:Controller/);
  assert.equal(searchInput.dataset.focused, "1");
  assert.match(qaInput.value, /调用链/);
});

test("web context bundle markdown includes multiple selected source details", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const element = () => {
    const node = {
      addEventListener() {},
      appendChild() {},
      append() {},
      checked: false,
      classList: { add() {}, remove() {}, toggle() { return false; } },
      click() {},
      dataset: {},
      disabled: false,
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
      textContent: "",
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
  const inputs = new Map<string, ReturnType<typeof element>>();
  const projectRoot = element();
  projectRoot.value = "/repo/app";
  inputs.set("project-root", projectRoot);
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
      getElementById(id: string) { return inputs.get(id) || element(); },
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
    window: { confirm() { return false; }, isSecureContext: false, location: { href: "" } },
  });

  vm.runInContext(appJs, context);
  const markdown = vm.runInContext(`buildContextBundleMarkdown([
    {
      filePath: "src/a.ts",
      startLine: 3,
      endLine: 5,
      language: "typescript",
      reason: "symbol+snippet",
      score: 0.91,
      snippet: "export function search() {\\n  return true;\\n}",
      explanation: { matchedSources: ["symbol"], matchedTokens: ["search"], snippetMatch: true }
    },
    {
      filePath: "src/b.ts",
      startLine: 12,
      endLine: 15,
      language: "typescript",
      reason: "path",
      score: 0.72,
      snippet: "export const route = '/search';"
    }
  ], "claude", "找潜在 bug，并给出修改建议")`, context) as string;
  const codexMarkdown = vm.runInContext(`buildContextBundleMarkdown([
    {
      filePath: "src/a.ts",
      startLine: 3,
      language: "typescript",
      snippet: "export function search() {}"
    }
  ], "codex", "补测试")`, context) as string;
  const selectorHtml = vm.runInContext(`renderSourceBundleSelector({
    filePath: "src/a.ts",
    startLine: 3,
    snippet: "export function search() {}"
  }, "search-0")`, context) as string;
  const toolbarHtml = vm.runInContext(`renderContextBundleToolbar("search")`, context) as string;

  assert.match(markdown, /Claude Code/);
  assert.match(markdown, /任务说明：找潜在 bug，并给出修改建议/);
  assert.match(markdown, /项目根目录：\/repo\/app/);
  assert.match(markdown, /共 2 个代码片段/);
  assert.match(markdown, /\/repo\/app\/src\/a\.ts:3/);
  assert.match(markdown, /src\/b\.ts:12/);
  assert.match(markdown, /symbol\+snippet/);
  assert.match(markdown, /Score: 0\.91/);
  assert.match(markdown, /Matched tokens: search/);
  assert.match(markdown, /```typescript\nexport function search\(\)/);
  assert.match(markdown, /export const route = '\/search';/);
  assert.match(codexMarkdown, /Codex/);
  assert.match(codexMarkdown, /任务说明：补测试/);
  assert.match(codexMarkdown, /\/repo\/app\/src\/a\.ts:3/);
  assert.match(selectorHtml, /class="source-bundle-selector"/);
  assert.match(selectorHtml, /data-bundle-source=/);
  assert.match(toolbarHtml, /data-context-bundle-task/);
  assert.match(toolbarHtml, /任务说明/);
  assert.match(toolbarHtml, /data-context-bundle-preset="找潜在 bug"/);
  assert.match(toolbarHtml, /data-context-bundle-preset="补测试"/);
  assert.match(toolbarHtml, /复制上下文包/);
  assert.match(toolbarHtml, /发送到 Codex/);
  assert.match(toolbarHtml, /发送到 Claude/);
});

test("web search and QA results lazy-load wider source context", () => {
  const appJs = readFileSync(path.join(rootDir, "src/web/static/js/app.js"), "utf8");
  const css = readFileSync(path.join(rootDir, "src/web/static/css/main.css"), "utf8");
  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const changelog = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const roadmap = readFileSync(path.join(rootDir, "ROADMAP.md"), "utf8");

  assert.match(appJs, /const LAZY_CONTEXT_LINES = 30;/);
  assert.match(appJs, /function buildLazyContextRange\(/);
  assert.match(appJs, /function renderLazyContextAction\(/);
  assert.match(appJs, /function bindLazyContextActions\(/);
  assert.match(appJs, /async function loadLazyContextPreview\(/);
  assert.match(appJs, /function renderLazyContextSnippet\(/);
  assert.match(appJs, /response\?\.meta\?\.snippet\?\.endLine/);
  assert.match(appJs, /data-context-action="load"/);
  assert.match(appJs, /data-context-file-path="\$\{escapeHtmlAttribute\(source\.filePath\)\}"/);
  assert.match(appJs, /data-context-project-root-path="\$\{escapeHtmlAttribute\(getSourceProjectRootPath\(source\)\)\}"/);
  assert.match(appJs, /data-context-start-line="\$\{range\.startLine\}"/);
  assert.match(appJs, /data-context-end-line="\$\{range\.endLine\}"/);
  assert.match(appJs, /request\("POST", "\/api\/file-snippet"/);
  assert.match(appJs, /projectRootPath: button\.getAttribute\("data-context-project-root-path"\) \|\| getProjectRootPath\(\)/);
  assert.match(appJs, /filePath: button\.getAttribute\("data-context-file-path"\)/);
  assert.match(appJs, /startLine: Number\(button\.getAttribute\("data-context-start-line"\)/);
  assert.match(appJs, /endLine: Number\(button\.getAttribute\("data-context-end-line"\)/);
  assert.match(appJs, /lazy-context-preview/);
  assert.match(appJs, /bindLazyContextActions\(\)/);
  assert.match(appJs, /renderLazyContextAction\(item\)/);
  assert.match(appJs, /renderLazyContextAction\(source\)/);
  assert.match(css, /\.lazy-context-preview/);
  assert.match(css, /\.lazy-context-action/);
  assert.match(css, /\.lazy-context-error/);
  assert.match(readme, /懒加载上下文预览/);
  assert.match(readme, /更多上下文/);
  assert.match(changelog, /Lazy context preview/);
  assert.match(roadmap, /懒加载上下文预览/);

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
  const actionHtml = vm.runInContext(`renderLazyContextAction({
    filePath: "src/example.ts",
    startLine: 40,
    endLine: 45,
    snippet: ""
  })`, context) as string;
  assert.match(actionHtml, /data-context-action="load"/);
  assert.match(actionHtml, /data-context-start-line="10"/);
  assert.match(actionHtml, /data-context-end-line="75"/);
  assert.match(actionHtml, />更多上下文</);
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
