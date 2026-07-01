#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));

function printHelp() {
  console.log(`Usage: node scripts/check-secrets.mjs [options]

Checks that sensitive environment token values are not present in project files,
release artifacts produced by npm pack / release:win, or git history. Secret
values are never printed; findings only report redacted values and locations.

Options:
  --token-env <name>        Environment variable to scan for. Defaults to GITEE_TOKEN.
  --include-artifacts       Scan tgz and Windows zip release artifacts. Enabled by default.
  --skip-artifacts          Do not scan release artifacts.
  --skip-history            Do not scan git history.
  --version <version>       Version used for artifact names. Defaults to package.json version.
  -h, --help                Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    includeArtifacts: true,
    scanHistory: true,
    tokenEnv: "GITEE_TOKEN",
    version: pkg.version,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--include-artifacts") {
      options.includeArtifacts = true;
      continue;
    }
    if (arg === "--skip-artifacts") {
      options.includeArtifacts = false;
      continue;
    }
    if (arg === "--skip-history") {
      options.scanHistory = false;
      continue;
    }
    if (arg === "--token-env") {
      options.tokenEnv = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--version") {
      options.version = requireValue(argv, index, arg);
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

function buildSecret(options) {
  const value = process.env[options.tokenEnv];
  if (!value) {
    return undefined;
  }
  return {
    envName: options.tokenEnv,
    label: `${options.tokenEnv}=redacted`,
    value,
  };
}

function shouldSkipDirectory(name) {
  return [".git", "node_modules", ".npm-cache", ".ace-mcp", ".codex"].includes(name);
}

function scanProjectFiles(secret) {
  const findings = [];
  walkProject(rootDir, (filePath) => {
    if (fileContainsSecret(filePath, secret.value)) {
      findings.push({
        location: path.relative(rootDir, filePath),
        secret: secret.label,
        type: "file",
      });
    }
  });
  return findings;
}

function walkProject(dir, onFile) {
  for (const name of readdirSync(dir)) {
    if (shouldSkipDirectory(name)) {
      continue;
    }
    const filePath = path.join(dir, name);
    const stat = lstatSync(filePath);
    if (stat.isDirectory()) {
      walkProject(filePath, onFile);
    } else if (stat.isFile()) {
      onFile(filePath);
    }
  }
}

function fileContainsSecret(filePath, secretValue) {
  return readFileSync(filePath).includes(Buffer.from(secretValue));
}

function scanGitHistory(secret) {
  const result = spawnSync("git", ["log", "--all", "--format=%H", `-S${secret.value}`, "--", "."], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git log --all secret scan failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((commit) => ({
      location: commit.slice(0, 12),
      secret: secret.label,
      type: "git-history",
    }));
}

function scanPackedArtifacts(secret, version) {
  const findings = [];
  const artifactScanners = [
    {
      existsCommand: ["tar", ["-tf", `ace-mcp-${version}.tgz`]],
      label: `ace-mcp-${version}.tgz`,
      path: path.join(rootDir, `ace-mcp-${version}.tgz`),
      scanCommand: ["tar", ["-xOf", `ace-mcp-${version}.tgz`]],
    },
    {
      existsCommand: ["unzip", ["-l", `release/ace-mcp-v${version}-win-x64.zip`]],
      label: `release/ace-mcp-v${version}-win-x64.zip`,
      path: path.join(rootDir, "release", `ace-mcp-v${version}-win-x64.zip`),
      // Windows artifact scan command: unzip -p release/ace-mcp-v${version}-win-x64.zip
      scanCommand: ["unzip", ["-p", `release/ace-mcp-v${version}-win-x64.zip`]],
    },
  ];

  for (const artifact of artifactScanners) {
    if (!existsSync(artifact.path)) {
      console.log(`[skip] ${artifact.label} missing`);
      continue;
    }
    ensureArchiveReadable(artifact);
    if (archiveContainsSecret(artifact, secret.value)) {
      findings.push({
        location: artifact.label,
        secret: secret.label,
        type: "artifact",
      });
    }
  }

  return findings;
}

function ensureArchiveReadable(artifact) {
  const [command, args] = artifact.existsCommand;
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${artifact.label} cannot be listed: ${result.stderr.trim()}`);
  }
}

function archiveContainsSecret(artifact, secretValue) {
  const [command, args] = artifact.scanCommand;
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "buffer",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${artifact.label} cannot be scanned: ${String(result.stderr).trim()}`);
  }
  return result.stdout.includes(Buffer.from(secretValue));
}

function reportFindings(findings) {
  if (findings.length === 0) {
    return;
  }
  for (const finding of findings) {
    console.error(`[leak] ${finding.type}: ${finding.location} contains ${finding.secret}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const secret = buildSecret(options);
  if (!secret) {
    console.log(`[skip] ${options.tokenEnv} is not set; nothing sensitive to compare`);
    console.log("check-secrets ok: no configured secret value to scan");
    return;
  }

  const findings = [];
  findings.push(...scanProjectFiles(secret));
  if (options.includeArtifacts) {
    findings.push(...scanPackedArtifacts(secret, options.version));
  }
  if (options.scanHistory) {
    findings.push(...scanGitHistory(secret));
  }

  reportFindings(findings);
  if (findings.length > 0) {
    throw new Error(`check-secrets found ${findings.length} leak(s) for ${secret.label}`);
  }

  console.log(`check-secrets ok: ${secret.envName}=redacted not found in project files, artifacts, or git history`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
