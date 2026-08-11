#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = pkg.version;
const tgzPath = path.join(rootDir, `ace-mcp-${version}.tgz`);
const winZipPath = path.join(rootDir, "release", `ace-mcp-v${version}-win-x64.zip`);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ace-mcp-smoke-"));
const prefixDir = path.join(tempRoot, "prefix");
const homeDir = path.join(tempRoot, "home");
const windowsExtractDir = path.join(tempRoot, "windows");
const env = {
  ...process.env,
  ACE_MCP_LOG_LEVEL: "error",
  HOME: homeDir,
  USERPROFILE: homeDir,
};

function fail(message) {
  throw new Error(message);
}

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env,
    windowsHide: true,
    ...options,
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

function getBinPath(name) {
  if (process.platform === "win32") {
    return path.join(prefixDir, `${name}.cmd`);
  }
  return path.join(prefixDir, "bin", name);
}

function getBinInvocation(command, args) {
  if (process.platform !== "win32" || path.extname(command).toLowerCase() !== ".cmd") {
    return { args, command };
  }

  return {
    args: ["/d", "/c", "call", command, ...args],
    command: process.env.ComSpec || "cmd.exe",
  };
}

function runBin(label, command, args, options = {}) {
  const invocation = getBinInvocation(command, args);
  return run(label, invocation.command, invocation.args, options);
}

function spawnBin(command, args, options) {
  const invocation = getBinInvocation(command, args);
  return spawn(invocation.command, invocation.args, options);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("Could not allocate a local TCP port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function fetchHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`/health returned ${response.statusCode}: ${body}`));
          return;
        }
        try {
          const payload = JSON.parse(body);
          if (payload.status !== "ok") {
            reject(new Error(`/health returned unexpected payload: ${body}`));
            return;
          }
          resolve(payload);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(1000, () => {
      request.destroy(new Error("health request timed out"));
    });
    request.on("error", reject);
  });
}

async function waitForHealth(port, timeoutMs, getLogs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetchHealth(port);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  fail(`ace-mcp-web did not serve /health within ${timeoutMs}ms: ${message}\n${getLogs()}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let exited = false;
    const timer = setTimeout(() => {
      if (!exited) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.once("exit", () => {
      exited = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    spawnSync(path.join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
    });
  } else {
    child.kill("SIGTERM");
  }
  await waitForExit(child, 5000);
}

async function smokeWeb(label, command, cwd, childEnv) {
  const port = await getFreePort();
  const logs = { stderr: "", stdout: "" };
  const child = spawnBin(command, [String(port)], {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    logs.stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    logs.stderr += chunk;
  });
  child.on("error", (error) => {
    logs.stderr += error.message;
  });

  try {
    await waitForHealth(port, 20000, () => `${label}\n${logs.stdout}\n${logs.stderr}`.trim());
  } finally {
    await stopChild(child);
  }

  return port;
}

async function main() {
  if (process.platform !== "win32") {
    fail("release:smoke must run on Windows because the release includes a self-contained Windows runtime.");
  }

  if (!existsSync(tgzPath)) {
    fail(`Missing ${path.basename(tgzPath)}. Run npm run release:pack first.`);
  }

  if (!existsSync(winZipPath)) {
    fail(`Missing release/${path.basename(winZipPath)}. Run npm run release:win first.`);
  }

  mkdirSync(prefixDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(windowsExtractDir, { recursive: true });

  runBin("npm install", npmCommand, [
    "install",
    "-g",
    "--prefix",
    prefixDir,
    tgzPath,
    "--cache",
    path.join(rootDir, ".npm-cache"),
  ]);

  const aceMcpBin = getBinPath("ace-mcp");
  const configureCodexBin = getBinPath("ace-mcp-configure-codex");
  const aceMcpWebBin = getBinPath("ace-mcp-web");

  if (!existsSync(aceMcpBin)) {
    fail(`Missing installed ace-mcp binary at ${aceMcpBin}`);
  }

  if (!existsSync(aceMcpWebBin)) {
    fail(`Missing installed ace-mcp-web binary at ${aceMcpWebBin}`);
  }

  if (!existsSync(configureCodexBin)) {
    fail(`Missing installed ace-mcp-configure-codex binary at ${configureCodexBin}`);
  }

  const reportedVersion = runBin("ace-mcp --version", aceMcpBin, ["--version"]);
  if (reportedVersion !== version) {
    fail(`ace-mcp --version returned ${reportedVersion}, expected ${version}`);
  }

  runBin("ace-mcp --doctor", aceMcpBin, ["--doctor"]);
  runBin("ace-mcp-configure-codex", configureCodexBin, []);
  const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
  const codexConfig = TOML.parse(readFileSync(codexConfigPath, "utf8"));
  const expectedDataDir = path.join(homeDir, ".ace-mcp");
  if (!codexConfig.sandbox_workspace_write?.writable_roots?.includes(expectedDataDir)) {
    fail(`Codex config does not grant workspace-write access to ${expectedDataDir}`);
  }
  const npmPort = await smokeWeb("npm ace-mcp-web", aceMcpWebBin, tempRoot, env);

  run("extract Windows zip", "tar.exe", ["-xf", winZipPath, "-C", windowsExtractDir]);
  const windowsPackageDir = path.join(windowsExtractDir, `ace-mcp-v${version}-win-x64`);
  const windowsAceMcp = path.join(windowsPackageDir, "ace-mcp.cmd");
  const windowsAceMcpWeb = path.join(windowsPackageDir, "ace-mcp-web.cmd");
  const bundledNode = path.join(windowsPackageDir, "runtime", "node.exe");
  const bundledBinding = path.join(windowsPackageDir, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

  for (const requiredPath of [windowsAceMcp, windowsAceMcpWeb, bundledNode, bundledBinding]) {
    if (!existsSync(requiredPath)) {
      fail(`Missing self-contained Windows file: ${requiredPath}`);
    }
  }

  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const isolatedWindowsEnv = {
    ...env,
    ACE_MCP_BUNDLED_RUNTIME: "1",
    PATH: `${path.join(systemRoot, "System32")};${systemRoot}`,
  };
  const windowsVersion = runBin("Windows ace-mcp --version", windowsAceMcp, ["--version"], {
    cwd: windowsPackageDir,
    env: isolatedWindowsEnv,
  });
  if (windowsVersion !== version) {
    fail(`Windows ace-mcp --version returned ${windowsVersion}, expected ${version}`);
  }
  runBin("Windows ace-mcp --doctor without Node/npm on PATH", windowsAceMcp, ["--doctor"], {
    cwd: windowsPackageDir,
    env: isolatedWindowsEnv,
  });
  const windowsPort = await smokeWeb(
    "self-contained Windows ace-mcp-web",
    windowsAceMcpWeb,
    windowsPackageDir,
    isolatedWindowsEnv,
  );

  console.log(`release smoke ok: ace-mcp ${version}, npm /health on ${npmPort}, self-contained Windows /health on ${windowsPort}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });
