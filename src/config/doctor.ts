import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import type { Settings } from "../core/common/types.js";

const execFileAsync = promisify(execFile);
const MIN_NODE_VERSION = "18.18.0";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  fix?: string;
  id: string;
  message: string;
  name: string;
  status: DoctorStatus;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
  summary: Record<DoctorStatus, number>;
}

type DoctorSettings = Pick<
  Settings,
  | "dataDir"
  | "databasePath"
  | "embeddingApiKey"
  | "embeddingApiUrl"
  | "embeddingProvider"
  | "llmApiKey"
  | "llmApiUrl"
  | "logDir"
  | "settingsFilePath"
>;

export interface DoctorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  settings: DoctorSettings;
  webPort?: number;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) {
      return a > b ? 1 : -1;
    }
  }

  return 0;
}

function createCheck(status: DoctorStatus, id: string, name: string, message: string, fix?: string): DoctorCheck {
  return { fix, id, message, name, status };
}

async function checkNpm(env: NodeJS.ProcessEnv, cwd: string): Promise<DoctorCheck> {
  if (env.ACE_MCP_BUNDLED_RUNTIME === "1") {
    return createCheck("ok", "npm", "npm", "not required by the bundled runtime");
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    const result = await execFileAsync(npmCommand, ["--version"], {
      cwd,
      env,
      shell: process.platform === "win32",
      timeout: 5000,
      windowsHide: true,
    });
    return createCheck("ok", "npm", "npm", `npm ${result.stdout.trim()} is available`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createCheck(
      "warn",
      "npm",
      "npm",
      `npm is not available; runtime features are unaffected: ${message}`,
      "Install npm only when upgrading or developing from source.",
    );
  }
}

async function checkWritableDirectory(id: string, name: string, directory: string): Promise<DoctorCheck> {
  const probePath = path.join(directory, `.ace-mcp-doctor-${process.pid}-${Date.now()}`);

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probePath, "ok", "utf8");
    await access(probePath);
    await rm(probePath, { force: true });
    return createCheck("ok", id, name, `${directory} is writable`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createCheck(
      "error",
      id,
      name,
      `${directory} is not writable: ${message}`,
      "Fix directory permissions or set HOME/USERPROFILE to a writable location.",
    );
  }
}

async function checkPort(port: number): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(createCheck(
          "warn",
          "web-port",
          "Web port",
          `127.0.0.1:${port} is already in use`,
          "Start with another port, for example: ace-mcp-web 9000",
        ));
        return;
      }

      resolve(createCheck(
        "warn",
        "web-port",
        "Web port",
        `Could not check 127.0.0.1:${port}: ${error.message}`,
        "Verify local firewall or port permissions if the Web panel cannot start.",
      ));
    });

    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(createCheck("ok", "web-port", "Web port", `127.0.0.1:${port} is available`));
      });
    });
  });
}

function checkBetterSqlite(): DoctorCheck {
  try {
    const db = new Database(":memory:");
    db.prepare("SELECT 1 AS value").get();
    db.close();
    return createCheck("ok", "better-sqlite3", "better-sqlite3", "native SQLite binding loaded");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createCheck(
      "error",
      "better-sqlite3",
      "better-sqlite3",
      `native SQLite binding failed to load: ${message}`,
      "Use Node.js 20/22 LTS. On Windows, install Visual Studio Build Tools with Desktop development with C++.",
    );
  }
}

function checkSqliteFts5(): DoctorCheck {
  try {
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE doctor_fts USING fts5(content)");
    db.prepare("INSERT INTO doctor_fts(content) VALUES (?)").run("ace mcp health check");
    const row = db.prepare("SELECT rowid FROM doctor_fts WHERE doctor_fts MATCH ?").get("health") as { rowid: number } | undefined;
    db.close();

    if (row?.rowid === 1) {
      return createCheck("ok", "sqlite-fts5", "SQLite FTS5", "FTS5 virtual tables are available");
    }

    return createCheck(
      "error",
      "sqlite-fts5",
      "SQLite FTS5",
      "FTS5 query returned no rows",
      "Reinstall better-sqlite3 or use a supported Node.js LTS runtime.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createCheck(
      "error",
      "sqlite-fts5",
      "SQLite FTS5",
      `FTS5 is not available: ${message}`,
      "Reinstall better-sqlite3 or use a supported Node.js LTS runtime.",
    );
  }
}

function checkNodeVersion(): DoctorCheck {
  const current = process.versions.node;
  if (compareVersions(current, MIN_NODE_VERSION) >= 0) {
    return createCheck("ok", "node-version", "Node.js", `Node.js v${current} satisfies >=${MIN_NODE_VERSION}`);
  }

  return createCheck(
    "error",
    "node-version",
    "Node.js",
    `Node.js v${current} is older than ${MIN_NODE_VERSION}`,
    "Install Node.js 20 or 22 LTS, then run ace-mcp --doctor again.",
  );
}

function checkLlmConfig(settings: DoctorSettings): DoctorCheck {
  if (settings.llmApiUrl) {
    if (!settings.llmApiKey) {
      return createCheck(
        "warn",
        "llm-config",
        "LLM config",
        "LLM API URL is set, but API key is empty",
        "Set ACE_MCP_LLM_API_KEY if your endpoint requires authentication.",
      );
    }

    return createCheck("ok", "llm-config", "LLM config", "LLM API URL and key are configured");
  }

  return createCheck(
    "warn",
    "llm-config",
    "LLM config",
    "LLM config is not set; search still works, but ask_codebase/generate_summary need an LLM endpoint",
    "Set ACE_MCP_LLM_API_URL and ACE_MCP_LLM_API_KEY before using ask_codebase.",
  );
}

function checkEmbeddingConfig(settings: DoctorSettings): DoctorCheck {
  if (settings.embeddingProvider !== "remote") {
    return createCheck("ok", "embedding-config", "Embedding config", "using built-in memory embedding provider");
  }

  if (settings.embeddingApiUrl) {
    return createCheck("ok", "embedding-config", "Embedding config", "remote embedding endpoint is configured");
  }

  return createCheck(
    "warn",
    "embedding-config",
    "Embedding config",
    "remote embedding provider is selected but endpoint is empty; ace-mcp will fall back to memory embeddings",
    "Set ACE_MCP_EMBEDDING_API_URL or unset ACE_MCP_EMBEDDING_PROVIDER=remote.",
  );
}

export async function runDoctorChecks(options: DoctorOptions): Promise<DoctorResult> {
  const env = { ...process.env, ...options.env };
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    checkBetterSqlite(),
    checkSqliteFts5(),
    checkLlmConfig(options.settings),
    checkEmbeddingConfig(options.settings),
  ];

  checks.push(await checkNpm(env, options.cwd ?? process.cwd()));
  checks.push(await checkWritableDirectory("data-dir-writable", "Data directory", options.settings.dataDir));
  checks.push(await checkWritableDirectory("log-dir-writable", "Log directory", options.settings.logDir));
  checks.push(await checkWritableDirectory("settings-dir-writable", "Settings directory", path.dirname(options.settings.settingsFilePath)));
  checks.push(await checkPort(options.webPort ?? 8787));

  const summary = checks.reduce<Record<DoctorStatus, number>>(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { error: 0, ok: 0, warn: 0 },
  );

  return {
    checks,
    ok: summary.error === 0,
    summary,
  };
}

export function formatDoctorReport(result: DoctorResult): string {
  const lines = [
    "ace-mcp doctor",
    `Platform: ${os.platform()} ${os.release()} (${os.arch()})`,
    `Summary: ${result.summary.ok} ok, ${result.summary.warn} warn, ${result.summary.error} error`,
    "",
  ];

  for (const check of result.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}`);
  }

  const fixes = result.checks.filter((check) => check.fix);
  if (fixes.length > 0) {
    lines.push("", "Next steps:");
    for (const check of fixes) {
      lines.push(`- ${check.name}: ${check.fix}`);
    }
  }

  return lines.join("\n");
}
