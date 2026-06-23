import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  assert.equal(pkg.version, "4.6.7");
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.bin["ace-mcp"], "dist/index.js");
  assert.equal(pkg.bin["ace-mcp-web"], "scripts/start-web.mjs");
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("scripts"));
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.includes("CHANGELOG.md"));
  assert.ok(pkg.files.includes("!dist/**/*.test.*"));
  assert.ok(pkg.files.includes("!dist/test/**"));
  assert.equal(pkg.scripts["release:pack"], "npm run build && npm pack");
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
});
