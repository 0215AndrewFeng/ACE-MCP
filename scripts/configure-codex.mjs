#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import TOML from "@iarna/toml";

const SECTION_NAME = "sandbox_workspace_write";

function usage() {
  console.log(`Usage: ace-mcp-configure-codex [options]

Allow Codex workspace-write sandboxes to write ace-mcp's SQLite data.

Options:
  --config <path>    Codex config file (default: $CODEX_HOME/config.toml or ~/.codex/config.toml)
  --data-dir <path>  ace-mcp data root (default: ~/.ace-mcp)
  -h, --help         Show this help`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--config" || arg === "--data-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      options[arg === "--config" ? "configPath" : "dataDir"] = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function parseConfig(text, configPath) {
  if (!text.trim()) return {};
  try {
    return TOML.parse(text);
  } catch (error) {
    throw new Error(`Cannot update invalid TOML at ${configPath}: ${error.message}`);
  }
}

function formatRoots(roots) {
  return `[${roots.map((root) => JSON.stringify(root)).join(", ")}]`;
}

function findArrayEnd(text, start, limit) {
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let index = start; index < limit; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error("Cannot locate the end of sandbox_workspace_write.writable_roots");
}

function mergeWritableRoot(text, roots) {
  const sectionPattern = /^\s*\[sandbox_workspace_write\]\s*(?:#.*)?$/m;
  const sectionMatch = sectionPattern.exec(text);
  const assignment = `writable_roots = ${formatRoots(roots)}`;

  if (!sectionMatch) {
    const prefix = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${prefix}[${SECTION_NAME}]\n${assignment}\n`;
  }

  const sectionBodyStart = sectionMatch.index + sectionMatch[0].length;
  const nextSectionMatch = /^\s*\[[^\n]+\]\s*(?:#.*)?$/m.exec(text.slice(sectionBodyStart));
  const sectionEnd = nextSectionMatch ? sectionBodyStart + nextSectionMatch.index : text.length;
  const sectionBody = text.slice(sectionBodyStart, sectionEnd);
  const rootMatch = /^([ \t]*)writable_roots[ \t]*=/m.exec(sectionBody);

  if (!rootMatch) {
    const insertion = `${sectionBody.endsWith("\n") || sectionBody.length === 0 ? "" : "\n"}${assignment}\n`;
    return `${text.slice(0, sectionEnd)}${insertion}${text.slice(sectionEnd)}`;
  }

  const assignmentStart = sectionBodyStart + rootMatch.index;
  const equalsOffset = rootMatch[0].lastIndexOf("=");
  const valueSearchStart = assignmentStart + equalsOffset + 1;
  const arrayStart = text.indexOf("[", valueSearchStart);
  if (arrayStart < 0 || arrayStart >= sectionEnd) {
    throw new Error("sandbox_workspace_write.writable_roots must be a TOML array");
  }
  const arrayEnd = findArrayEnd(text, arrayStart, sectionEnd);
  const replacement = `${rootMatch[1]}${assignment}`;
  return `${text.slice(0, assignmentStart)}${replacement}${text.slice(arrayEnd)}`;
}

function samePath(left, right) {
  return left === right || path.resolve(left) === path.resolve(right);
}

export function configureCodex({ configPath, dataDir }) {
  const existingText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const config = parseConfig(existingText, configPath);
  const currentRoots = config[SECTION_NAME]?.writable_roots ?? [];
  if (!Array.isArray(currentRoots) || currentRoots.some((root) => typeof root !== "string")) {
    throw new Error(`${SECTION_NAME}.writable_roots must be an array of paths`);
  }
  if (currentRoots.some((root) => samePath(root, dataDir))) {
    return { changed: false, configPath, dataDir };
  }

  const nextText = mergeWritableRoot(existingText, [...currentRoots, dataDir]);
  parseConfig(nextText, configPath);

  const configDir = path.dirname(configPath);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(configDir, `.config.toml.ace-mcp-${process.pid}-${Date.now()}`);
  const mode = existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o600;
  try {
    writeFileSync(tempPath, nextText, { mode });
    renameSync(tempPath, configPath);
    chmodSync(configPath, mode);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return { changed: true, configPath, dataDir };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  const configPath = options.configPath ?? path.join(codexHome, "config.toml");
  const dataDir = options.dataDir ?? path.join(os.homedir(), ".ace-mcp");
  const result = configureCodex({ configPath, dataDir: path.resolve(dataDir) });
  if (result.changed) {
    console.log(`[ace-mcp] Added ${result.dataDir} to sandbox_workspace_write.writable_roots in ${result.configPath}.`);
    console.log("[ace-mcp] Restart Codex so new MCP processes receive the updated sandbox permissions.");
  } else {
    console.log(`[ace-mcp] Codex writable root already configured: ${result.dataDir}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[ace-mcp] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
