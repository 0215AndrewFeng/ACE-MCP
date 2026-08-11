import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configureScript = path.join(rootDir, "scripts", "configure-codex.mjs");

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ace-mcp-codex-config-"));
  const codexHome = path.join(root, ".codex");
  const dataDir = path.join(root, ".ace-mcp");
  const configPath = path.join(codexHome, "config.toml");
  return { codexHome, configPath, dataDir, root };
}

function runConfigure(fixture) {
  return spawnSync(process.execPath, [configureScript, "--config", fixture.configPath, "--data-dir", fixture.dataDir], {
    cwd: rootDir,
    encoding: "utf8",
  });
}

test("configure-codex creates the sandbox workspace-write section for a new config", () => {
  const fixture = createFixture();
  try {
    const result = runConfigure(fixture);
    assert.equal(result.status, 0, result.stderr);
    const config = TOML.parse(readFileSync(fixture.configPath, "utf8"));
    assert.deepEqual(config.sandbox_workspace_write?.writable_roots, [fixture.dataDir]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("configure-codex merges with existing roots and preserves unrelated config", () => {
  const fixture = createFixture();
  try {
    mkdirSync(fixture.codexHome, { recursive: true });
    writeFileSync(fixture.configPath, [
      "model = \"gpt-5.6-sol\"",
      "",
      "[sandbox_workspace_write]",
      "network_access = true",
      "writable_roots = [",
      "  \"/existing/root\",",
      "]",
      "",
      "[projects.\"/repo\"]",
      "trust_level = \"trusted\"",
      "",
    ].join("\n"));

    const result = runConfigure(fixture);
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(fixture.configPath, "utf8");
    const config = TOML.parse(text);
    assert.deepEqual(config.sandbox_workspace_write?.writable_roots, ["/existing/root", fixture.dataDir]);
    assert.equal(config.model, "gpt-5.6-sol");
    assert.equal(config.projects?.["/repo"]?.trust_level, "trusted");
    assert.match(text, /network_access = true/);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("configure-codex adds writable_roots to an existing sandbox section", () => {
  const fixture = createFixture();
  try {
    mkdirSync(fixture.codexHome, { recursive: true });
    writeFileSync(fixture.configPath, [
      "[sandbox_workspace_write]",
      "network_access = true",
      "",
      "[tui]",
      "notifications = true",
      "",
    ].join("\n"));

    const result = runConfigure(fixture);
    assert.equal(result.status, 0, result.stderr);
    const config = TOML.parse(readFileSync(fixture.configPath, "utf8"));
    assert.deepEqual(config.sandbox_workspace_write?.writable_roots, [fixture.dataDir]);
    assert.equal(config.sandbox_workspace_write?.network_access, true);
    assert.equal(config.tui?.notifications, true);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("configure-codex is idempotent when the ace-mcp data root is already writable", () => {
  const fixture = createFixture();
  try {
    const first = runConfigure(fixture);
    assert.equal(first.status, 0, first.stderr);
    const before = readFileSync(fixture.configPath, "utf8");

    const second = runConfigure(fixture);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(fixture.configPath, "utf8"), before);
    assert.match(second.stdout, /already configured/i);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("configure-codex rejects invalid TOML without overwriting it", () => {
  const fixture = createFixture();
  try {
    mkdirSync(fixture.codexHome, { recursive: true });
    const invalid = "[sandbox_workspace_write\nwritable_roots = []\n";
    writeFileSync(fixture.configPath, invalid);

    const result = runConfigure(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid TOML/i);
    assert.equal(readFileSync(fixture.configPath, "utf8"), invalid);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});
