#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));

function printHelp() {
  console.log(`Usage: node scripts/verify-release-assets.mjs [options]

Checks that the Gitee release tag and downloadable release assets are reachable.

Options:
  --version <version>      Release version to verify. Defaults to package.json version.
  --base-url <url>         Repository base URL. Defaults to https://gitee.com/AndrewFengCode/ace-mcp
  --timeout-ms <ms>        Per-request timeout. Defaults to 15000.
  --skip-installer         Do not verify the tag-pinned macOS installer script URL.
  -h, --help              Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    baseUrl: "https://gitee.com/AndrewFengCode/ace-mcp",
    skipInstaller: false,
    timeoutMs: 15000,
    version: pkg.version,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--skip-installer") {
      options.skipInstaller = true;
      continue;
    }
    if (arg === "--version") {
      options.version = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--base-url") {
      options.baseUrl = requireValue(argv, index, arg).replace(/\/+$/, "");
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = Number(requireValue(argv, index, arg));
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--timeout-ms must be a positive number");
      }
      options.timeoutMs = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function buildChecks({ baseUrl, skipInstaller, version }) {
  const checks = [
    {
      label: `release tag v${version}`,
      url: `${baseUrl}/releases/tag/v${version}`,
    },
    {
      label: `tgz ace-mcp-${version}.tgz`,
      url: `${baseUrl}/releases/download/v${version}/ace-mcp-${version}.tgz`,
    },
    {
      label: `Windows zip ace-mcp-v${version}-win-x64.zip`,
      url: `${baseUrl}/releases/download/v${version}/ace-mcp-v${version}-win-x64.zip`,
    },
  ];

  if (!skipInstaller) {
    checks.push({
      label: `macOS installer script v${version}`,
      url: `${baseUrl}/raw/v${version}/scripts/install-macos.sh`,
    });
  }

  return checks;
}

function requestUrl(url, timeoutMs, method = "HEAD", redirectCount = 0) {
  const parsed = new URL(url);
  const transport = parsed.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const request = transport.request(parsed, { method }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;
      response.resume();

      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        if (redirectCount >= 5) {
          reject(new Error(`too many redirects for ${url}`));
          return;
        }
        const nextUrl = new URL(location, parsed).toString();
        resolve(requestUrl(nextUrl, timeoutMs, method, redirectCount + 1));
        return;
      }

      if (method === "HEAD" && (statusCode === 405 || statusCode === 403)) {
        resolve(requestUrl(url, timeoutMs, "GET", redirectCount));
        return;
      }

      resolve({
        finalUrl: url,
        method,
        statusCode,
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    request.end();
  });
}

async function verifyCheck(check, timeoutMs) {
  const result = await requestUrl(check.url, timeoutMs);
  if (result.statusCode < 200 || result.statusCode >= 400) {
    throw new Error(`${check.label} returned HTTP ${result.statusCode}: ${check.url}`);
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const checks = buildChecks(options);
  for (const check of checks) {
    const result = await verifyCheck(check, options.timeoutMs);
    console.log(`[ok] ${check.label} -> HTTP ${result.statusCode}`);
  }

  console.log(`verify-release-assets ok: ${checks.length} checks for v${options.version}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
