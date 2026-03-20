import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as TOML from "@iarna/toml";

import type { Settings } from "../core/common/types.js";

type RawSettings = Partial<
  Pick<
    Settings,
    | "batchSize"
    | "defaultTopK"
    | "excludePatterns"
    | "logLevel"
    | "maxFileSizeKb"
    | "maxLinesPerChunk"
    | "textExtensions"
  >
>;

const DEFAULT_PUBLIC_SETTINGS = {
  batchSize: 32,
  defaultTopK: 8,
  excludePatterns: [
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    "bin",
    "obj",
    "__pycache__",
    ".venv",
    ".idea",
    ".vscode",
  ],
  logLevel: "info",
  maxFileSizeKb: 1024,
  maxLinesPerChunk: 220,
  textExtensions: [".java", ".js", ".jsx", ".ts", ".tsx", ".cs", ".py"],
} satisfies RawSettings;

function coerceArray(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function loadSettings(): Promise<Settings> {
  const baseDir = path.join(os.homedir(), ".ace-mcp");
  const dataDir = path.join(baseDir, "data");
  const logDir = path.join(baseDir, "log");
  const settingsFilePath = path.join(baseDir, "settings.toml");
  const databasePath = path.join(dataDir, "index.db");
  const logFilePath = path.join(logDir, "ace-mcp.log");

  await mkdir(dataDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  let fileSettings: RawSettings = {};
  try {
    const content = await readFile(settingsFilePath, "utf8");
    const parsed = TOML.parse(content) as RawSettings;
    fileSettings = parsed;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (Object.keys(fileSettings).length === 0) {
    await writeFile(settingsFilePath, TOML.stringify(DEFAULT_PUBLIC_SETTINGS), "utf8");
  }

  const envExtensions = coerceArray(process.env.ACE_MCP_TEXT_EXTENSIONS);
  const envExcludes = coerceArray(process.env.ACE_MCP_EXCLUDE_PATTERNS);

  return {
    batchSize:
      Number(process.env.ACE_MCP_BATCH_SIZE ?? fileSettings.batchSize ?? DEFAULT_PUBLIC_SETTINGS.batchSize),
    dataDir,
    databasePath,
    defaultTopK:
      Number(process.env.ACE_MCP_DEFAULT_TOP_K ?? fileSettings.defaultTopK ?? DEFAULT_PUBLIC_SETTINGS.defaultTopK),
    excludePatterns: envExcludes ?? fileSettings.excludePatterns ?? DEFAULT_PUBLIC_SETTINGS.excludePatterns,
    logDir,
    logFilePath,
    logLevel:
      (process.env.ACE_MCP_LOG_LEVEL ?? fileSettings.logLevel ?? DEFAULT_PUBLIC_SETTINGS.logLevel) as Settings["logLevel"],
    maxFileSizeKb:
      Number(process.env.ACE_MCP_MAX_FILE_SIZE_KB ?? fileSettings.maxFileSizeKb ?? DEFAULT_PUBLIC_SETTINGS.maxFileSizeKb),
    maxLinesPerChunk:
      Number(
        process.env.ACE_MCP_MAX_LINES_PER_CHUNK ??
          fileSettings.maxLinesPerChunk ??
          DEFAULT_PUBLIC_SETTINGS.maxLinesPerChunk,
      ),
    settingsFilePath,
    textExtensions: envExtensions ?? fileSettings.textExtensions ?? DEFAULT_PUBLIC_SETTINGS.textExtensions,
  };
}
