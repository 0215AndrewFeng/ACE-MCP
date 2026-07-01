#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));

function printHelp() {
  console.log(`Usage: node scripts/publish-gitee-release.mjs [options]

Creates or updates the Gitee Release, replaces release attachments, uploads
the tgz and Windows zip artifacts, then verifies public release downloads.

Options:
  --version <version>       Release version. Defaults to package.json version.
  --owner <owner>           Gitee owner. Defaults to AndrewFengCode.
  --repo <repo>             Gitee repository. Defaults to ace-mcp.
  --token-env <name>        Environment variable containing the token. Defaults to GITEE_TOKEN.
  --base-url <url>          Repository base URL. Defaults to https://gitee.com/AndrewFengCode/ace-mcp.
  --api-base-url <url>      Gitee API base URL. Defaults to https://gitee.com/api/v5.
  --timeout-ms <ms>         Per-network-operation timeout. Defaults to 30000.
  --skip-verify             Do not run scripts/verify-release-assets.mjs after upload.
  --dry-run                 Validate local inputs and print intended API operations only.
  -h, --help                Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    apiBaseUrl: "https://gitee.com/api/v5",
    baseUrl: "https://gitee.com/AndrewFengCode/ace-mcp",
    dryRun: false,
    owner: "AndrewFengCode",
    repo: "ace-mcp",
    skipVerify: false,
    timeoutMs: 30000,
    tokenEnv: "GITEE_TOKEN",
    version: pkg.version,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--skip-verify") {
      options.skipVerify = true;
      continue;
    }
    if (arg === "--version") {
      options.version = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--owner") {
      options.owner = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      options.repo = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--token-env") {
      options.tokenEnv = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--base-url") {
      options.baseUrl = requireValue(argv, index, arg).replace(/\/+$/, "");
      index += 1;
      continue;
    }
    if (arg === "--api-base-url") {
      options.apiBaseUrl = requireValue(argv, index, arg).replace(/\/+$/, "");
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

function ensureVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
}

function runGit(args, description) {
  const result = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`${description} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout.trim();
}

function getReleaseCommit(version) {
  // Tag check command: git rev-parse --verify v${version}^{}
  return runGit(["rev-parse", "--verify", `v${version}^{}`], `git tag v${version} lookup`);
}

function requiredArtifacts(version) {
  return [
    {
      label: "npm tgz",
      name: `ace-mcp-${version}.tgz`,
      path: path.join(rootDir, `ace-mcp-${version}.tgz`),
    },
    {
      label: "Windows zip",
      name: `ace-mcp-v${version}-win-x64.zip`,
      path: path.join(rootDir, "release", `ace-mcp-v${version}-win-x64.zip`),
    },
  ];
}

function assertArtifact(artifact) {
  if (!existsSync(artifact.path)) {
    throw new Error(`Missing ${artifact.label} artifact: ${path.relative(rootDir, artifact.path)}`);
  }
  const stat = statSync(artifact.path);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Invalid ${artifact.label} artifact: ${path.relative(rootDir, artifact.path)}`);
  }
  return stat.size;
}

function extractChangelogSection(version) {
  const changelogPath = path.join(rootDir, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    return "";
  }
  const changelog = readFileSync(changelogPath, "utf8");
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\][^\\n]*\\n`, "m");
  const match = heading.exec(changelog);
  if (!match) {
    return "";
  }
  const start = match.index + match[0].length;
  const next = changelog.slice(start).search(/^## \[/m);
  return changelog.slice(start, next === -1 ? undefined : start + next).trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildReleaseBody(version) {
  const changelogSection = extractChangelogSection(version);
  const artifacts = [
    `ace-mcp-${version}.tgz`,
    `ace-mcp-v${version}-win-x64.zip`,
  ];
  const artifactLines = artifacts.map((artifact) => `- ${artifact}`).join("\n");
  const changelogText = changelogSection || "- Gitee Release automatic publish pipeline.";
  return `${changelogText}

### Artifacts

${artifactLines}
`;
}

function withAccessToken(url, accessToken) {
  url.searchParams.set("access_token", accessToken);
  return url;
}

async function apiRequest(options, method, pathname, body) {
  const url = withAccessToken(
    new URL(`${options.apiBaseUrl}${pathname}`),
    options.accessToken,
  );
  const formBody = body === undefined ? undefined : toFormBody(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      body: formBody,
      headers: formBody === undefined ? undefined : { "content-type": "application/x-www-form-urlencoded" },
      method,
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? parseJson(text, pathname) : undefined;
    if (!response.ok) {
      const message = parsed?.message || parsed?.error || text || response.statusText;
      const error = new Error(`${method} ${pathname} failed: HTTP ${response.status} ${message}`);
      error.status = response.status;
      throw error;
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function toFormBody(body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    params.set(key, String(value));
  }
  return params;
}

function parseJson(text, context) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${context}: ${text.slice(0, 200)}`);
  }
}

function releasePath(options) {
  // Gitee API path: /api/v5/repos/${owner}/${repo}/releases
  return `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/releases`;
}

function releaseTagPath(options, version) {
  return `${releasePath(options)}/tags/v${encodeURIComponent(version)}`;
}

async function getReleaseByTag(options, version) {
  try {
    return await apiRequest(options, "GET", releaseTagPath(options, version));
  } catch (error) {
    if (error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function createOrUpdateRelease(options, version, commit) {
  const payload = {
    body: buildReleaseBody(version),
    name: `v${version}`,
    prerelease: false,
    tag_name: `v${version}`,
    target_commitish: commit,
  };
  const existing = await getReleaseByTag(options, version);
  if (existing?.id) {
    const release = await apiRequest(options, "PATCH", `${releasePath(options)}/${existing.id}`, payload);
    console.log(`[ok] updated Gitee Release v${version} (#${release.id})`);
    return release;
  }

  const release = await apiRequest(options, "POST", releasePath(options), payload);
  console.log(`[ok] created Gitee Release v${version} (#${release.id})`);
  return release;
}

async function listAttachments(options, release) {
  return await apiRequest(options, "GET", `${releasePath(options)}/${release.id}/attach_files`) ?? [];
}

async function deleteMatchingAttachments(options, release, artifactNames) {
  const attachments = await listAttachments(options, release);
  for (const attachment of attachments) {
    if (!artifactNames.has(attachment.name)) {
      continue;
    }
    await apiRequest(options, "DELETE", `${releasePath(options)}/${release.id}/attach_files/${attachment.id}`);
    console.log(`[ok] deleted existing attachment ${attachment.name} (#${attachment.id})`);
  }
}

async function uploadArtifact(options, release, artifact) {
  // Attach API path: /releases/${release.id}/attach_files
  const pathname = `${releasePath(options)}/${release.id}/attach_files`;
  const url = withAccessToken(new URL(`${options.apiBaseUrl}${pathname}`), options.accessToken);
  const form = new FormData();
  const blob = await createFileBlob(artifact.path);
  form.append("file", blob, artifact.name);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      body: form,
      method: "POST",
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? parseJson(text, pathname) : undefined;
    if (!response.ok) {
      const message = parsed?.message || parsed?.error || text || response.statusText;
      throw new Error(`POST ${pathname} failed: HTTP ${response.status} ${message}`);
    }
    console.log(`[ok] uploaded ${artifact.name}`);
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function createFileBlob(filePath) {
  if (typeof fs.openAsBlob === "function") {
    return await fs.openAsBlob(filePath);
  }
  return new Blob([readFileSync(filePath)]);
}

function verifyReleaseAssets(version, timeoutMs, baseUrl) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/verify-release-assets.mjs",
      "--version",
      version,
      "--base-url",
      baseUrl,
      "--timeout-ms",
      String(timeoutMs),
    ],
    {
      cwd: rootDir,
      stdio: "inherit",
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`verify-release-assets.mjs failed with exit code ${result.status ?? 1}`);
  }
}

function validateLocalInputs(options) {
  ensureVersion(options.version);
  if (pkg.version !== options.version) {
    throw new Error(`package.json version ${pkg.version} does not match --version ${options.version}`);
  }
  const commit = getReleaseCommit(options.version);
  const artifacts = requiredArtifacts(options.version);
  for (const artifact of artifacts) {
    const size = assertArtifact(artifact);
    console.log(`[ok] ${artifact.name} (${size} bytes)`);
  }
  return { artifacts, commit };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const { artifacts, commit } = validateLocalInputs(options);
  console.log(`[ok] tag v${options.version} -> ${commit}`);

  if (options.dryRun) {
    console.log(`[dry-run] would create/update release v${options.version} on ${options.owner}/${options.repo}`);
    console.log(`[dry-run] would replace attachments: ${artifacts.map((artifact) => artifact.name).join(", ")}`);
    console.log("release:publish ok (dry-run)");
    return;
  }

  const accessToken = process.env[options.tokenEnv];
  if (!accessToken) {
    throw new Error(`Missing ${options.tokenEnv}. Export a Gitee personal access token before publishing.`);
  }
  options.accessToken = accessToken;

  const release = await createOrUpdateRelease(options, options.version, commit);
  await deleteMatchingAttachments(options, release, new Set(artifacts.map((artifact) => artifact.name)));
  for (const artifact of artifacts) {
    await uploadArtifact(options, release, artifact);
  }
  if (!options.skipVerify) {
    verifyReleaseAssets(options.version, options.timeoutMs, options.baseUrl);
  }
  console.log(`release:publish ok: v${options.version}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
