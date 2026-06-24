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

  assert.equal(pkg.version, "4.7.0");
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
  assert.equal(pkg.scripts["release:check"], "npm test && npm run build && npm run release:pack && npm run release:win && npm run release:smoke");
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
  const cmdInstallPath = path.join(rootDir, "scripts/install-windows.cmd");
  const psInstallPath = path.join(rootDir, "scripts/install-windows.ps1");

  assert.equal(existsSync(packageScriptPath), true);
  assert.equal(existsSync(smokeScriptPath), true);
  assert.equal(existsSync(cmdInstallPath), true);
  assert.equal(existsSync(psInstallPath), true);

  const packageScript = readFileSync(packageScriptPath, "utf8");
  const smokeScript = readFileSync(smokeScriptPath, "utf8");
  const cmdInstall = readFileSync(cmdInstallPath, "utf8");
  const psInstall = readFileSync(psInstallPath, "utf8");

  assert.match(packageScript, /ace-mcp-v\$\{version\}-win-x64/);
  assert.match(packageScript, /\$\{packageName\}\.zip/);
  assert.match(packageScript, /README-WINDOWS\.md/);
  assert.match(packageScript, /install\.ps1/);
  assert.match(packageScript, /start-web\.cmd/);
  assert.match(smokeScript, /npm install/);
  assert.match(smokeScript, /ace-mcp --version/);
  assert.match(smokeScript, /ace-mcp-web/);
  assert.match(smokeScript, /\/health/);
  assert.match(smokeScript, /ace-mcp-smoke-/);
  assert.match(smokeScript, /waitForExit/);
  assert.match(smokeScript, /SIGKILL/);
  assert.doesNotMatch(smokeScript, /ace-mcp smoke /);
  assert.match(cmdInstall, /npm install --omit=dev/);
  assert.match(cmdInstall, /better-sqlite3/);
  assert.match(cmdInstall, /--doctor/);
  assert.match(psInstall, /npm install --omit=dev/);
  assert.match(psInstall, /ExecutionPolicy/);
  assert.match(psInstall, /--doctor/);
});

test("Windows README documents zip installation and MCP client command paths", () => {
  const windowsReadme = readFileSync(path.join(rootDir, "scripts/README-WINDOWS.md"), "utf8");

  assert.match(windowsReadme, /ace-mcp-v4\.7\.0-win-x64\.zip/);
  assert.match(windowsReadme, /install\.ps1/);
  assert.match(windowsReadme, /start-web\.cmd/);
  assert.match(windowsReadme, /ace-mcp\.cmd/);
  assert.match(windowsReadme, /better-sqlite3/);
  assert.match(windowsReadme, /ExecutionPolicy/);
});

test("release checklist records the v4.7.0 verification gates", () => {
  const checklist = readFileSync(path.join(rootDir, "docs/release-checklist.md"), "utf8");

  assert.match(checklist, /v4\.7\.0/);
  assert.match(checklist, /npm test/);
  assert.match(checklist, /npm run build/);
  assert.match(checklist, /npm run release:pack/);
  assert.match(checklist, /npm run release:win/);
  assert.match(checklist, /npm run release:smoke/);
  assert.match(checklist, /git tag -a v4\.7\.0/);
});
