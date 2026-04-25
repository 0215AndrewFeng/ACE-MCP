const MAX_HISTORY = 20;

const resultEl = document.getElementById("result");
const projectRootInput = document.getElementById("project-root");
const projectRootSelect = document.getElementById("project-root-select");
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
const searchHistoryEl = document.getElementById("search-history");

let searchHistory = JSON.parse(localStorage.getItem("ace-mcp-search-history") || "[]");

function saveHistory() {
  localStorage.setItem("ace-mcp-search-history", JSON.stringify(searchHistory));
  renderHistory();
}

function renderHistory() {
  if (!searchHistoryEl) return;
  searchHistoryEl.innerHTML = searchHistory.map((item, i) =>
    `<span class="search-history-item" data-index="${i}">${escapeHtml(item.query)}</span>`
  ).join("");
  searchHistoryEl.querySelectorAll(".search-history-item").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.index || "0");
      const item = searchHistory[idx];
      searchQueryInput.value = item.query;
      searchModeInput.value = item.mode || "auto";
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

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
  return [...new Set(value.split(",").map(item => item.trim().toLowerCase()).filter(item => allowed.has(item)))];
}

function render(data) {
  resultEl.textContent = JSON.stringify(data, null, 2);
}

async function run(action) {
  resultEl.textContent = "Loading...";
  resultEl.classList.add("loading");
  try {
    const data = await action();
    render(data);
  } catch (error) {
    resultEl.textContent = error instanceof Error ? error.message : String(error);
    resultEl.classList.add("error");
    setTimeout(() => resultEl.classList.remove("error"), 3000);
  } finally {
    resultEl.classList.remove("loading");
  }
}

function addToHistory(query, mode) {
  searchHistory.unshift({ query, mode });
  if (searchHistory.length > MAX_HISTORY) searchHistory.pop();
  saveHistory();
}

document.getElementById("load-health")?.addEventListener("click", () => run(() => request("GET", "/health")));
document.getElementById("load-runtime")?.addEventListener("click", () => run(() => request("GET", "/api/runtime")));
document.getElementById("load-config")?.addEventListener("click", () => run(() => request("GET", "/api/config")));
document.getElementById("load-tools")?.addEventListener("click", () => run(() => request("GET", "/api/tools")));
document.getElementById("load-projects")?.addEventListener("click", () => run(async () => {
  const data = await request("GET", "/api/projects");
  // Populate project selector
  if (projectRootSelect && data.projects) {
    projectRootSelect.innerHTML = '<option value="">-- Select a project --</option>' +
      data.projects.map(p => `<option value="${escapeHtml(p.projectRootPath)}">${escapeHtml(p.projectRootPath)}</option>`).join("");
  }
  return data;
}));

projectRootSelect?.addEventListener("change", () => {
  if (projectRootSelect.value) {
    projectRootInput.value = projectRootSelect.value;
  }
});

document.getElementById("run-index")?.addEventListener("click", () => run(() => request("POST", "/api/index-project", {
  mode: indexModeInput.value,
  projectRootPath: projectRootInput.value
})));

document.getElementById("run-stats")?.addEventListener("click", () => run(() => request(
  "GET",
  "/api/project-stats?projectRootPath=" + encodeURIComponent(projectRootInput.value)
)));

document.getElementById("run-search")?.addEventListener("click", () => {
  const query = searchQueryInput.value;
  const mode = searchModeInput.value;
  addToHistory(query, mode);
  run(() => request("POST", "/api/search-context", {
    includeContextLines: Number(includeContextLinesInput.value || 0),
    languages: parseSearchLanguages(searchLanguagesInput.value),
    mode: mode,
    excludePathPrefix: searchExcludePathPrefixInput.value.trim() || undefined,
    pathContains: searchPathContainsInput.value.trim() || undefined,
    pathPrefix: searchPathPrefixInput.value.trim() || undefined,
    projectRootPath: projectRootInput.value,
    query: query,
    resultMode: searchResultModeInput.value,
    topK: Number(topKInput.value || 8)
  }));
});

document.getElementById("run-snippet")?.addEventListener("click", () => run(() => request("POST", "/api/file-snippet", {
  projectRootPath: projectRootInput.value,
  filePath: snippetPathInput.value,
  startLine: Number(snippetStartInput.value || 1),
  endLine: Number(snippetEndInput.value || 1)
})));

renderHistory();
