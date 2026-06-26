#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = pkg.version;
const packageName = `ace-mcp-v${version}-win-x64`;
const releaseDir = path.join(rootDir, "release");
const stageDir = path.join(releaseDir, packageName);
const zipPath = path.join(releaseDir, `${packageName}.zip`);

function copyRequired(relativePath, targetRelativePath = relativePath) {
  const from = path.join(rootDir, relativePath);
  const to = path.join(stageDir, targetRelativePath);
  if (!existsSync(from)) {
    throw new Error(`Missing required release input: ${relativePath}`);
  }
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

function writeWindowsWrapper(relativePath, content) {
  const target = path.join(stageDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content.replace(/\n/g, "\r\n"));
}

function runZip() {
  if (process.platform === "win32") {
    const command = `Compress-Archive -Path "${stageDir}" -DestinationPath "${zipPath}" -Force`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: releaseDir,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    return;
  }

  const result = spawnSync("zip", ["-qr", zipPath, packageName], {
    cwd: releaseDir,
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("zip command not found. Install zip or run this script on Windows with PowerShell Compress-Archive.");
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(stageDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(stageDir, { recursive: true });

[
  "dist",
  "scripts/start-web.mjs",
  "scripts/start-web.cmd",
  "scripts/start-web.ps1",
  "scripts/install-windows.cmd",
  "scripts/install-windows.ps1",
  "scripts/smoke-release.mjs",
  "scripts/benchmark-search.mjs",
  "package.json",
  "package-lock.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
].forEach((file) => copyRequired(file));
copyRequired("scripts/README-WINDOWS.md", "README-WINDOWS.md");

writeWindowsWrapper("install.cmd", "@echo off\ncall \"%~dp0scripts\\install-windows.cmd\" %*\n");
writeWindowsWrapper("install.ps1", "& \"$PSScriptRoot\\scripts\\install-windows.ps1\" @args\n");
writeWindowsWrapper("start-web.cmd", "@echo off\ncall \"%~dp0scripts\\start-web.cmd\" %*\n");
writeWindowsWrapper("start-web.ps1", "& \"$PSScriptRoot\\scripts\\start-web.ps1\" @args\n");

runZip();
console.log(`Created ${path.relative(rootDir, zipPath)}`);
