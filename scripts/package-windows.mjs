#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = pkg.version;
const packageName = `ace-mcp-v${version}-win-x64`;
const releaseDir = path.join(rootDir, "release");
const stageDir = path.join(releaseDir, packageName);
const zipPath = path.join(releaseDir, `${packageName}.zip`);
const nodeMajor = Number(process.versions.node.split(".")[0]);

function fail(message) {
  throw new Error(message);
}

function requireReleaseHost() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    fail("The self-contained Windows release must be built on Windows x64.");
  }
  if (nodeMajor !== 22) {
    fail(`The Windows release must be built with Node.js 22.x; current runtime is ${process.version}.`);
  }
}

function copyRequired(relativePath, targetRelativePath = relativePath) {
  const from = path.join(rootDir, relativePath);
  const to = path.join(stageDir, targetRelativePath);
  if (!existsSync(from)) {
    fail(`Missing required release input: ${relativePath}`);
  }
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

function writeWindowsWrapper(relativePath, content) {
  const target = path.join(stageDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content.replace(/\n/g, "\r\n"));
}

function run(label, command, args, cwd = stageDir) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });

  if (result.error) {
    fail(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail([
      `${label} exited with ${result.status}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join("\n"));
  }

  return result.stdout.trim();
}

function getNpmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const npmCliPath = candidates.find((candidate) => existsSync(candidate));
  if (!npmCliPath) {
    fail("npm CLI was not found in the release environment. Run this script through npm run release:win.");
  }
  return npmCliPath;
}

function writeLaunchers() {
  writeWindowsWrapper("ace-mcp.cmd", `@echo off
setlocal
set "ACE_MCP_BUNDLED_RUNTIME=1"
"%~dp0runtime\\node.exe" "%~dp0dist\\index.js" %*
exit /b %ERRORLEVEL%
`);

  writeWindowsWrapper("ace-mcp.ps1", `$env:ACE_MCP_BUNDLED_RUNTIME = "1"
& "$PSScriptRoot\\runtime\\node.exe" "$PSScriptRoot\\dist\\index.js" @args
exit $LASTEXITCODE
`);

  writeWindowsWrapper("ace-mcp-web.cmd", `@echo off
setlocal
set "PORT=%ACE_MCP_WEB_PORT%"
if "%PORT%"=="" set "PORT=8787"
if not "%~1"=="" set "PORT=%~1"
set "ACE_MCP_BUNDLED_RUNTIME=1"
"%~dp0runtime\\node.exe" "%~dp0dist\\index.js" --web-port "%PORT%"
exit /b %ERRORLEVEL%
`);

  writeWindowsWrapper("ace-mcp-web.ps1", `$port = if ($args.Count -gt 0) { $args[0] } elseif ($env:ACE_MCP_WEB_PORT) { $env:ACE_MCP_WEB_PORT } else { "8787" }
$env:ACE_MCP_BUNDLED_RUNTIME = "1"
& "$PSScriptRoot\\runtime\\node.exe" "$PSScriptRoot\\dist\\index.js" --web-port $port
exit $LASTEXITCODE
`);

  writeWindowsWrapper("start-web.cmd", "@echo off\ncall \"%~dp0ace-mcp-web.cmd\" %*\n");
  writeWindowsWrapper("start-web.ps1", "& \"$PSScriptRoot\\ace-mcp-web.ps1\" @args\nexit $LASTEXITCODE\n");
  writeWindowsWrapper("doctor.cmd", "@echo off\ncall \"%~dp0ace-mcp.cmd\" --doctor\n");
  writeWindowsWrapper("install.cmd", `@echo off
echo ace-mcp is self-contained; no installation or npm download is required.
call "%~dp0doctor.cmd"
if errorlevel 1 exit /b %ERRORLEVEL%
echo.
echo Start Web UI: start-web.cmd
echo MCP command: %~dp0ace-mcp.cmd
`);
  writeWindowsWrapper("install.ps1", `Write-Host "ace-mcp is self-contained; no installation or npm download is required."
& "$PSScriptRoot\\ace-mcp.ps1" --doctor
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""
Write-Host "Start Web UI: .\\start-web.cmd"
Write-Host "MCP command: $PSScriptRoot\\ace-mcp.cmd"
`);
}

function pruneDevelopmentDependencies() {
  const npmCliPath = getNpmCliPath();
  run("npm prune --omit=dev", process.execPath, [
    npmCliPath,
    "prune",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
}

function verifyStagedRuntime() {
  const runtime = path.join(stageDir, "runtime", "node.exe");
  const nativeBinding = path.join(stageDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

  if (!existsSync(nativeBinding)) {
    fail("Missing better-sqlite3 Windows native binding. Run npm ci with Node.js 22 before release:win.");
  }
  const reportedVersion = run("bundled ace-mcp --version", runtime, ["dist/index.js", "--version"]);
  if (reportedVersion !== version) {
    fail(`Bundled ace-mcp reported ${reportedVersion}; expected ${version}.`);
  }

  run(
    "bundled better-sqlite3 probe",
    runtime,
    ["-e", "const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('CREATE VIRTUAL TABLE t USING fts5(v)');db.close()"],
  );
}

function runZip() {
  const command = `Compress-Archive -Path "${stageDir}" -DestinationPath "${zipPath}" -Force`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: releaseDir,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

requireReleaseHost();
rmSync(stageDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(path.join(stageDir, "runtime"), { recursive: true });

[
  "dist",
  "node_modules",
  "scripts/reindex-projects.mjs",
  "package.json",
  "package-lock.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
].forEach((file) => copyRequired(file));
copyRequired("scripts/README-WINDOWS.md", "README-WINDOWS.md");
cpSync(process.execPath, path.join(stageDir, "runtime", "node.exe"));

pruneDevelopmentDependencies();
writeLaunchers();
verifyStagedRuntime();
runZip();

const sizeMb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`Created ${path.relative(rootDir, zipPath)} (${sizeMb} MiB, bundled Node ${process.version})`);
