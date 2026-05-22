import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as TOML from "@iarna/toml";

import type { Settings } from "../core/common/types.js";

type RawSettings = Partial<
  Pick<
    Settings,
    | "autoWatch"
    | "batchSize"
    | "defaultTopK"
    | "enableVectorSearch"
    | "excludePatterns"
    | "indexFreshness"
    | "indexFreshnessSeconds"
    | "llmApiKey"
    | "llmApiUrl"
    | "llmMaxTokens"
    | "llmModel"
    | "llmTemperature"
    | "logLevel"
    | "maxFileSizeKb"
    | "maxLinesPerChunk"
    | "searchCacheMaxSize"
    | "searchCacheTtlMs"
    | "searchFanoutLimit"
    | "textExtensions"
    | "vectorCacheMaxProjects"
    | "vectorIndexingMode"
  >
>;

const DEFAULT_PUBLIC_SETTINGS = {
  autoWatch: true,
  batchSize: 32,
  defaultTopK: 8,
  enableVectorSearch: true,
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
  textExtensions: [".java", ".js", ".jsx", ".ts", ".tsx", ".cs", ".py", ".md"],
  vectorIndexingMode: "lazy",
  indexFreshness: "stale",
  indexFreshnessSeconds: 30,
  searchCacheTtlMs: 60_000,
  searchCacheMaxSize: 100,
  vectorCacheMaxProjects: 10,
  searchFanoutLimit: 50,
  llmApiUrl: "",
  llmApiKey: "",
  llmModel: "gpt-4o-mini",
  llmMaxTokens: 2048,
  llmTemperature: 0.3,
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

function coerceBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

function coerceVectorIndexingMode(value: string | undefined): Settings["vectorIndexingMode"] | undefined {
  if (!value) {
    return undefined;
  }

  return value === "eager" ? "eager" : value === "lazy" ? "lazy" : undefined;
}

function coerceIndexFreshness(value: string | undefined): Settings["indexFreshness"] | undefined {
  if (!value) {
    return undefined;
  }

  const v = value.trim().toLowerCase();
  if (v === "always" || v === "stale" || v === "manual") {
    return v;
  }

  return undefined;
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
  const envEnableVectorSearch = coerceBoolean(process.env.ACE_MCP_ENABLE_VECTOR_SEARCH);
  const envVectorIndexingMode = coerceVectorIndexingMode(process.env.ACE_MCP_VECTOR_INDEXING_MODE);
  const envAutoWatch = coerceBoolean(process.env.ACE_MCP_AUTO_WATCH);
  const envEmbeddingProvider = (process.env.ACE_MCP_EMBEDDING_PROVIDER ?? "") === "remote" ? "remote" as const : undefined;
  const envIndexFreshness = coerceIndexFreshness(process.env.ACE_MCP_INDEX_FRESHNESS);

  return {
    autoWatch:
      envAutoWatch ?? fileSettings.autoWatch ?? DEFAULT_PUBLIC_SETTINGS.autoWatch,
    batchSize:
      Number(process.env.ACE_MCP_BATCH_SIZE ?? fileSettings.batchSize ?? DEFAULT_PUBLIC_SETTINGS.batchSize),
    dataDir,
    databasePath,
    defaultTopK:
      Number(process.env.ACE_MCP_DEFAULT_TOP_K ?? fileSettings.defaultTopK ?? DEFAULT_PUBLIC_SETTINGS.defaultTopK),
    embeddingApiKey: process.env.ACE_MCP_EMBEDDING_API_KEY ?? "",
    embeddingApiUrl: process.env.ACE_MCP_EMBEDDING_API_URL ?? "",
    embeddingModel: process.env.ACE_MCP_EMBEDDING_MODEL ?? "text-embedding-3-small",
    embeddingProvider:
      envEmbeddingProvider ?? "memory",
    enableVectorSearch:
      envEnableVectorSearch ?? fileSettings.enableVectorSearch ?? DEFAULT_PUBLIC_SETTINGS.enableVectorSearch,
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
    vectorIndexingMode:
      envVectorIndexingMode ?? fileSettings.vectorIndexingMode ?? DEFAULT_PUBLIC_SETTINGS.vectorIndexingMode,
    indexFreshness:
      envIndexFreshness ?? fileSettings.indexFreshness ?? DEFAULT_PUBLIC_SETTINGS.indexFreshness,
    indexFreshnessSeconds:
      Number(process.env.ACE_MCP_INDEX_FRESHNESS_SECONDS ?? fileSettings.indexFreshnessSeconds ?? DEFAULT_PUBLIC_SETTINGS.indexFreshnessSeconds),
    searchCacheTtlMs:
      Number(process.env.ACE_MCP_SEARCH_CACHE_TTL_MS ?? fileSettings.searchCacheTtlMs ?? DEFAULT_PUBLIC_SETTINGS.searchCacheTtlMs),
    searchCacheMaxSize:
      Number(process.env.ACE_MCP_SEARCH_CACHE_MAX_SIZE ?? fileSettings.searchCacheMaxSize ?? DEFAULT_PUBLIC_SETTINGS.searchCacheMaxSize),
    vectorCacheMaxProjects:
      Number(process.env.ACE_MCP_VECTOR_CACHE_MAX_PROJECTS ?? fileSettings.vectorCacheMaxProjects ?? DEFAULT_PUBLIC_SETTINGS.vectorCacheMaxProjects),
    searchFanoutLimit:
      Number(process.env.ACE_MCP_SEARCH_FANOUT_LIMIT ?? fileSettings.searchFanoutLimit ?? DEFAULT_PUBLIC_SETTINGS.searchFanoutLimit),
    llmApiUrl: process.env.ACE_MCP_LLM_API_URL ?? (fileSettings.llmApiUrl as string | undefined) ?? "",
    llmApiKey: process.env.ACE_MCP_LLM_API_KEY ?? (fileSettings.llmApiKey as string | undefined) ?? "",
    llmModel: process.env.ACE_MCP_LLM_MODEL ?? (fileSettings.llmModel as string | undefined) ?? "gpt-4o-mini",
    llmMaxTokens: Number(process.env.ACE_MCP_LLM_MAX_TOKENS ?? fileSettings.llmMaxTokens ?? 2048),
    llmTemperature: Number(process.env.ACE_MCP_LLM_TEMPERATURE ?? fileSettings.llmTemperature ?? 0.3),
  };
}

/** Persist LLM config fields into settings.toml (merge, not overwrite). */
export async function saveLlmConfig(
  settingsFilePath: string,
  updates: { llmApiKey?: string; llmApiUrl?: string; llmModel?: string; llmMaxTokens?: number; llmTemperature?: number },
): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const content = await readFile(settingsFilePath, "utf8");
    existing = TOML.parse(content) as Record<string, unknown>;
  } catch {
    // file missing or unparseable — start fresh
  }

  if (updates.llmApiUrl !== undefined) existing.llmApiUrl = updates.llmApiUrl;
  if (updates.llmApiKey !== undefined) existing.llmApiKey = updates.llmApiKey;
  if (updates.llmModel !== undefined) existing.llmModel = updates.llmModel;
  if (updates.llmMaxTokens !== undefined) existing.llmMaxTokens = updates.llmMaxTokens;
  if (updates.llmTemperature !== undefined) existing.llmTemperature = updates.llmTemperature;

  await writeFile(settingsFilePath, TOML.stringify(existing as any), "utf8");
}
