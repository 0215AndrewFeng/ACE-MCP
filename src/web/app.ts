import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

import {
  DEFAULT_INCLUDE_CONTEXT_LINES,
  MAX_INCLUDE_CONTEXT_LINES,
  type Settings,
  type SupportedLanguage,
} from "../core/common/types.js";
import type { Logger } from "../core/common/logger.js";
import { IndexCoordinator } from "../core/indexing/indexCoordinator.js";
import { readFileSnippet } from "../core/project/fileSnippet.js";
import { SearchService } from "../core/search/searchService.js";
import { SQLiteStore } from "../core/storage/sqliteStore.js";

interface WebAppDependencies {
  indexCoordinator: IndexCoordinator;
  logger: Logger;
  searchService: SearchService;
  settings: Settings;
  store: SQLiteStore;
}

const SUPPORTED_SEARCH_LANGUAGES = new Set<SupportedLanguage>(["java", "javascript", "dotnet", "python"]);

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(numericValue)));
}

function normalizePathPrefix(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePathContains(value: unknown): string | undefined {
  return normalizePathPrefix(value);
}

function normalizeSupportedLanguages(value: unknown): SupportedLanguage[] | undefined {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const languages = [...new Set(rawValues
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item): item is SupportedLanguage => SUPPORTED_SEARCH_LANGUAGES.has(item as SupportedLanguage)))];

  return languages.length > 0 ? languages : undefined;
}

function getHomePageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ace-mcp debug panel</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; line-height: 1.5; color: #111827; background: #f9fafb; }
      h1, h2 { margin-bottom: 8px; }
      p { margin-top: 0; }
      code, pre { font-family: ui-monospace, SFMono-Regular, monospace; }
      pre { background: #111827; color: #f9fafb; padding: 12px; border-radius: 8px; overflow: auto; min-height: 220px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
      .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; background: white; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
      .wide { grid-column: 1 / -1; }
      label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 4px; }
      input, select, textarea, button { width: 100%; box-sizing: border-box; font: inherit; }
      input, select, textarea { padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; margin-bottom: 12px; background: white; }
      textarea { min-height: 96px; resize: vertical; }
      button { padding: 10px 14px; border: 0; border-radius: 8px; background: #2563eb; color: white; cursor: pointer; font-weight: 600; }
      button.secondary { background: #374151; }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; }
      .actions button { width: auto; min-width: 160px; }
      .hint { font-size: 13px; color: #4b5563; }
      .mono { font-family: ui-monospace, SFMono-Regular, monospace; }
    </style>
  </head>
  <body>
    <h1>ace-mcp debug panel</h1>
    <p>Use this page to inspect server state and debug indexing, search, stats, and snippet retrieval.</p>
    <div class="grid">
      <div class="card wide">
        <h2>Quick actions</h2>
        <div class="actions">
          <button id="load-health" class="secondary" type="button">Load health</button>
          <button id="load-config" class="secondary" type="button">Load config</button>
          <button id="load-tools" class="secondary" type="button">Load tools</button>
          <button id="load-projects" class="secondary" type="button">Load projects</button>
        </div>
      </div>
      <div class="card">
        <h2>Index project</h2>
        <label for="project-root">Project root path</label>
        <input id="project-root" class="mono" placeholder="/path/to/project" />
        <label for="index-mode">Index mode</label>
        <select id="index-mode">
          <option value="incremental">incremental</option>
          <option value="full">full</option>
        </select>
        <button id="run-index" type="button">Run index_project</button>
      </div>
      <div class="card">
        <h2>Project stats</h2>
        <p class="hint">Fetch persisted stats for the current project root.</p>
        <button id="run-stats" type="button">Load project_stats</button>
      </div>
      <div class="card">
        <h2>Search context</h2>
        <label for="search-query">Query</label>
        <textarea id="search-query" placeholder="refund service implementation"></textarea>
        <label for="search-mode">Mode</label>
        <select id="search-mode">
          <option value="auto">auto</option>
          <option value="lexical">lexical</option>
          <option value="symbol">symbol</option>
          <option value="hybrid">hybrid</option>
        </select>
        <label for="top-k">Top K</label>
        <input id="top-k" type="number" min="1" max="50" value="8" />
        <label for="search-result-mode">Result mode</label>
        <select id="search-result-mode">
          <option value="full">full</option>
          <option value="metadata">metadata</option>
        </select>
        <label for="include-context-lines">Context lines</label>
        <input id="include-context-lines" type="number" min="0" max="50" value="0" />
        <label for="search-languages">Languages (comma-separated)</label>
        <input id="search-languages" class="mono" placeholder="javascript,java" />
        <label for="search-path-prefix">Path prefix</label>
        <input id="search-path-prefix" class="mono" placeholder="src/web" />
        <label for="search-path-contains">Path contains</label>
        <input id="search-path-contains" class="mono" placeholder="search" />
        <label for="search-exclude-path-prefix">Exclude path prefix</label>
        <input id="search-exclude-path-prefix" class="mono" placeholder="dist" />
        <button id="run-search" type="button">Run search_context</button>
      </div>
      <div class="card">
        <h2>Get file snippet</h2>
        <label for="snippet-path">File path (relative to project root)</label>
        <input id="snippet-path" class="mono" placeholder="src/index.ts" />
        <label for="snippet-start">Start line</label>
        <input id="snippet-start" type="number" min="1" value="1" />
        <label for="snippet-end">End line</label>
        <input id="snippet-end" type="number" min="1" value="40" />
        <button id="run-snippet" type="button">Run get_file_snippet</button>
      </div>
      <div class="card wide">
        <h2>Result</h2>
        <pre id="result">Click an action to begin.</pre>
      </div>
    </div>
    <script>
      const resultEl = document.getElementById("result");
      const projectRootInput = document.getElementById("project-root");
      const searchQueryInput = document.getElementById("search-query");
      const searchModeInput = document.getElementById("search-mode");
      const searchResultModeInput = document.getElementById("search-result-mode");
      const topKInput = document.getElementById("top-k");
      const includeContextLinesInput = document.getElementById("include-context-lines");
      const searchLanguagesInput = document.getElementById("search-languages");
      const searchPathContainsInput = document.getElementById("search-path-contains");
      const searchExcludePathPrefixInput = document.getElementById("search-exclude-path-prefix");
      const searchPathPrefixInput = document.getElementById("search-path-prefix");
      const snippetPathInput = document.getElementById("snippet-path");
      const snippetStartInput = document.getElementById("snippet-start");
      const snippetEndInput = document.getElementById("snippet-end");
      const indexModeInput = document.getElementById("index-mode");

      async function request(method, url, body) {
        const response = await fetch(url, {
          method,
          headers: body ? { "content-type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(JSON.stringify(data, null, 2));
        }
        return data;
      }

      function parseSearchLanguages(value) {
        const allowed = new Set(["java", "javascript", "dotnet", "python"]);
        return [...new Set(
          value
            .split(",")
            .map((item) => item.trim().toLowerCase())
            .filter((item) => allowed.has(item))
        )];
      }

      function render(data) {
        resultEl.textContent = JSON.stringify(data, null, 2);
      }

      async function run(action) {
        resultEl.textContent = "Loading...";
        try {
          const data = await action();
          render(data);
        } catch (error) {
          resultEl.textContent = error instanceof Error ? error.message : String(error);
        }
      }

      document.getElementById("load-health").addEventListener("click", () => run(() => request("GET", "/health")));
      document.getElementById("load-config").addEventListener("click", () => run(() => request("GET", "/api/config")));
      document.getElementById("load-tools").addEventListener("click", () => run(() => request("GET", "/api/tools")));
      document.getElementById("load-projects").addEventListener("click", () => run(() => request("GET", "/api/projects")));

      document.getElementById("run-index").addEventListener("click", () => run(() => request("POST", "/api/index-project", {
        mode: indexModeInput.value,
        projectRootPath: projectRootInput.value
      })));

      document.getElementById("run-stats").addEventListener("click", () => run(() => request(
        "GET",
        "/api/project-stats?projectRootPath=" + encodeURIComponent(projectRootInput.value)
      )));

      document.getElementById("run-search").addEventListener("click", () => run(() => request("POST", "/api/search-context", {
        includeContextLines: Number(includeContextLinesInput.value || 0),
        languages: parseSearchLanguages(searchLanguagesInput.value),
        mode: searchModeInput.value,
        excludePathPrefix: searchExcludePathPrefixInput.value.trim() || undefined,
        pathContains: searchPathContainsInput.value.trim() || undefined,
        pathPrefix: searchPathPrefixInput.value.trim() || undefined,
        projectRootPath: projectRootInput.value,
        query: searchQueryInput.value,
        resultMode: searchResultModeInput.value,
        topK: Number(topKInput.value || 8)
      })));

      document.getElementById("run-snippet").addEventListener("click", () => run(() => request("POST", "/api/file-snippet", {
        projectRootPath: projectRootInput.value,
        filePath: snippetPathInput.value,
        startLine: Number(snippetStartInput.value || 1),
        endLine: Number(snippetEndInput.value || 1)
      })));
    </script>
  </body>
</html>`;
}

function toolCatalog(): Array<{ description: string; name: string }> {
  return [
    { description: "Scan and index a local project for keyword, symbol, and path search.", name: "index_project" },
    {
      description:
        "Incrementally index the project and return code snippets relevant to a natural language, symbol, or path query, with optional context lines and path/language filters.",
      name: "search_context",
    },
    { description: "Read a range of lines from a project file.", name: "get_file_snippet" },
    { description: "Return indexing stats for a local project.", name: "project_stats" },
  ];
}

export async function startWebApp(port: number, dependencies: WebAppDependencies): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const pathname = requestUrl.pathname;

      if (request.method === "GET" && pathname === "/") {
        sendHtml(response, 200, getHomePageHtml());
        return;
      }

      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && pathname === "/api/config") {
        sendJson(response, 200, {
          batchSize: dependencies.settings.batchSize,
          dataDir: dependencies.settings.dataDir,
          databasePath: dependencies.settings.databasePath,
          defaultTopK: dependencies.settings.defaultTopK,
          excludePatterns: dependencies.settings.excludePatterns,
          logFilePath: dependencies.settings.logFilePath,
          maxFileSizeKb: dependencies.settings.maxFileSizeKb,
          maxLinesPerChunk: dependencies.settings.maxLinesPerChunk,
          textExtensions: dependencies.settings.textExtensions,
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/tools") {
        sendJson(response, 200, { tools: toolCatalog() });
        return;
      }

      if (request.method === "GET" && pathname === "/api/projects") {
        sendJson(response, 200, { projects: dependencies.store.listProjects() });
        return;
      }

      if (request.method === "GET" && pathname === "/api/project-stats") {
        const projectRootPath = requestUrl.searchParams.get("projectRootPath");
        if (!projectRootPath) {
          sendJson(response, 400, { error: "projectRootPath is required" });
          return;
        }

        sendJson(response, 200, dependencies.store.getProjectStats(projectRootPath) ?? { message: "Project not indexed" });
        return;
      }

      if (request.method === "POST" && pathname === "/api/file-snippet") {
        const body = await readJsonBody(request);
        const result = await readFileSnippet(
          String(body.projectRootPath ?? ""),
          String(body.filePath ?? ""),
          Number(body.startLine ?? 1),
          Number(body.endLine ?? 1),
        );
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && pathname === "/api/index-project") {
        const body = await readJsonBody(request);
        const projectRootPath = String(body.projectRootPath ?? "");
        const mode = body.mode === "full" ? "full" : "incremental";
        const result = await dependencies.indexCoordinator.indexProject(projectRootPath, mode);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && pathname === "/api/search-context") {
        const body = await readJsonBody(request);
        const projectRootPath = String(body.projectRootPath ?? "");
        const query = String(body.query ?? "");
        const mode = ["auto", "lexical", "symbol", "hybrid"].includes(String(body.mode ?? "auto"))
          ? (body.mode as "auto" | "lexical" | "symbol" | "hybrid")
          : "auto";
        const topK = clampInteger(body.topK, 1, 50, dependencies.settings.defaultTopK);
        const resultMode = ["full", "metadata"].includes(String(body.resultMode ?? "full"))
          ? (body.resultMode as "full" | "metadata")
          : "full";
        const includeContextLines = clampInteger(
          body.includeContextLines,
          DEFAULT_INCLUDE_CONTEXT_LINES,
          MAX_INCLUDE_CONTEXT_LINES,
          DEFAULT_INCLUDE_CONTEXT_LINES,
        );
        const excludePathPrefix = normalizePathPrefix(body.excludePathPrefix);
        const languages = normalizeSupportedLanguages(body.languages);
        const pathContains = normalizePathContains(body.pathContains);
        const pathPrefix = normalizePathPrefix(body.pathPrefix);
        const indexResult = await dependencies.indexCoordinator.indexProject(projectRootPath, "incremental");
        const result = await dependencies.searchService.search(
          indexResult.projectRootPath,
          query,
          mode,
          topK,
          includeContextLines,
          {
            excludePathPrefix,
            languages,
            pathContains,
            pathPrefix,
          },
          resultMode,
        );
        result.indexing = {
          changedFiles: indexResult.changedFiles,
          chunkCount: indexResult.chunkCount,
          createdAt: indexResult.createdAt,
          deletedFiles: indexResult.deletedFiles,
          failedFileCount: indexResult.failedFileCount,
          failedFiles: indexResult.failedFiles,
          indexedFiles: indexResult.indexedFiles,
          scannedFiles: indexResult.scannedFiles,
        };
        result.stats.indexedFiles = indexResult.indexedFiles;
        result.stats.scannedFiles = indexResult.scannedFiles;
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error: unknown) {
      dependencies.logger.error("web request failed", {
        error: error instanceof Error ? error.message : String(error),
        url: request.url,
      });
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  dependencies.logger.info("web debug panel started", { port });
}
