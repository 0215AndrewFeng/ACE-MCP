const MAX_HISTORY = 20;
const TOP_K_MAX = 50;
const MAX_INCLUDE_CONTEXT_LINES = 500;
const FILE_SNIPPET_MAX_END_LINE = 999999;
const QA_MAX_SOURCES = 100;
const QA_MAX_SOURCES_DEFAULT = 15;
const QA_MAX_CONTEXT_TOKENS = 200000;
const QA_CONTEXT_TOKENS_DEFAULT = 48000;
const QA_MAX_TOKENS = 32768;
const QA_TIMEOUT_SECONDS_MAX = 600;
const QA_RETRIES_MAX = 5;
const LAZY_CONTEXT_LINES = 30;
const CONTEXT_BUNDLE_TASK_PRESETS = [
  "解释这段逻辑",
  "找潜在 bug",
  "生成修改方案",
  "补测试",
];
const QUERY_TASK_TEMPLATES = [
  {
    id: "call-chain",
    label: "查调用链",
    qa: "这个方法在哪些入口被调用？请按调用链分层说明，并列出关键文件。",
    search: "symbol:Controller OR symbol:Service",
  },
  {
    id: "impact",
    label: "查影响面",
    qa: "修改这段逻辑可能影响哪些模块、接口和调用方？请按风险从高到低列出。",
    search: "find references impact usage",
  },
  {
    id: "bug-scan",
    label: "找潜在 bug",
    qa: "这段逻辑有哪些潜在空指针、边界条件、并发或异常处理问题？请给出修改建议。",
    search: "catch error null undefined timeout retry",
  },
  {
    id: "tests",
    label: "补单元测试",
    qa: "基于这些上下文补单元测试，覆盖正常路径、边界条件和异常路径。",
    search: "test spec mock assertion",
  },
  {
    id: "flow",
    label: "梳理业务流程",
    qa: "请按业务步骤梳理这段代码流程，说明入口、关键判断、下游调用和输出结果。",
    search: "flow process handler service",
  },
];

const resultEl = document.getElementById("result");
const resultSummaryEl = document.getElementById("result-summary");
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
const qaMaxSourcesInput = document.getElementById("qa-max-sources");
const qaMaxContextTokensInput = document.getElementById("qa-max-context-tokens");
const qaMaxTokensInput = document.getElementById("qa-max-tokens");
const qaTimeoutInput = document.getElementById("qa-timeout");
const qaRetriesInput = document.getElementById("qa-retries");
const serviceVersionEl = document.getElementById("service-version");
const serviceWatchStatusEl = document.getElementById("service-watch-status");
const serviceProjectsEl = document.getElementById("service-projects");
const serviceLatestIndexEl = document.getElementById("service-latest-index");
const serviceActiveTasksEl = document.getElementById("service-active-tasks");
const taskListEl = document.getElementById("task-list");
const taskFilterTypeInput = document.getElementById("task-filter-type");
const taskFilterStatusInput = document.getElementById("task-filter-status");
const qaEffectiveParamsEl = document.getElementById("qa-effective-params");

let searchHistory = JSON.parse(localStorage.getItem("ace-mcp-search-history") || "[]");

// ── v4.2.6: Project management with LocalStorage persistence ─────────────────
const PROJECT_LIST_KEY = 'ace-mcp-projects';
const SELECTED_PROJECT_KEY = 'ace-mcp-selected-project';

function getStoredProjects() {
  return JSON.parse(localStorage.getItem(PROJECT_LIST_KEY) || '[]');
}

function saveStoredProjects(projects) {
  localStorage.setItem(PROJECT_LIST_KEY, JSON.stringify(projects));
}

function addStoredProject(projectPath, fileCount = 0) {
  const projects = getStoredProjects();
  const existing = projects.find(p => p.path === projectPath);
  if (existing) {
    existing.fileCount = fileCount;
    existing.lastUsed = Date.now();
  } else {
    projects.push({ path: projectPath, fileCount, lastUsed: Date.now() });
  }
  saveStoredProjects(projects);
}

function removeStoredProject(projectPath) {
  const projects = getStoredProjects().filter(p => p.path !== projectPath);
  saveStoredProjects(projects);
}

function getSelectedProject() {
  return localStorage.getItem(SELECTED_PROJECT_KEY) || '';
}

function setSelectedProject(projectPath) {
  localStorage.setItem(SELECTED_PROJECT_KEY, projectPath);
}

function renderProjectSelect() {
  if (!projectRootSelect) return;
  const projects = getStoredProjects().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  projectRootSelect.innerHTML = '<option value="">-- 请选择项目 --</option>' +
    projects.map(p => `<option value="${escapeHtml(p.path)}">${escapeHtml(p.path)}${p.fileCount ? ` (${p.fileCount} 个文件)` : ''}</option>`).join("");

  // Restore selection
  const selected = getSelectedProject();
  if (selected && projects.some(p => p.path === selected)) {
    projectRootSelect.value = selected;
    projectRootInput.value = selected;
  }
}

function saveHistory() {
  localStorage.setItem("ace-mcp-search-history", JSON.stringify(searchHistory));
  renderHistory();
}

function renderHistory() {
  if (!searchHistoryEl) return;
  searchHistoryEl.innerHTML = searchHistory.map((item, i) =>
    `<span class="search-history-item" data-index="${i}" title="点击填充到搜索框">${escapeHtml(item.query)}</span>`
  ).join("");
  searchHistoryEl.querySelectorAll(".search-history-item").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.index || "0");
      const item = searchHistory[idx];
      // v4.2.8: Also fill QA question if search query is empty
      if (searchQueryInput) searchQueryInput.value = item.query;
      if (searchModeInput) searchModeInput.value = item.mode || "auto";
      const qaQuestion = document.getElementById("qa-question");
      if (qaQuestion && !qaQuestion.value.trim()) {
        qaQuestion.value = item.query;
      }
    });
  });
}

function renderQueryTemplateButtons(kind) {
  const target = kind === "search" ? "search-query" : "qa-question";
  return QUERY_TASK_TEMPLATES.map((template) => {
    const value = kind === "search" ? template.search : template.qa;
    return `<button type="button" class="query-template-button" data-query-template-target="${escapeHtmlAttribute(target)}" data-query-template-id="${escapeHtmlAttribute(template.id)}" data-query-template-value="${escapeHtmlAttribute(value)}">${escapeHtml(template.label)}</button>`;
  }).join("");
}

function applyQueryTemplate(button) {
  const targetId = button.getAttribute("data-query-template-target") || "";
  const value = button.getAttribute("data-query-template-value") || "";
  const input = targetId ? document.getElementById(targetId) : null;
  if (!input || !value) return;
  input.value = value;
  if (typeof input.focus === "function") input.focus();
}

function bindQueryTemplateActions() {
  document.querySelectorAll("[data-query-template-value]").forEach((button) => {
    if (button.dataset.queryTemplateBound === "1") return;
    button.dataset.queryTemplateBound = "1";
    button.addEventListener("click", () => applyQueryTemplate(button));
  });
}

function mountQueryTemplateButtons() {
  const qaPanel = document.getElementById("qa-template-buttons");
  const searchPanel = document.getElementById("search-template-buttons");
  if (qaPanel) qaPanel.innerHTML = renderQueryTemplateButtons("qa");
  if (searchPanel) searchPanel.innerHTML = renderQueryTemplateButtons("search");
  bindQueryTemplateActions();
}

mountQueryTemplateButtons();

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeHtmlAttribute(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ── v4.2.6: Syntax highlighting for code snippets ────────────────────────────
const SYNTAX_PATTERNS = {
  // Keywords by language
  keywords: {
    javascript: /\b(const|let|var|function|class|extends|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|new|delete|typeof|instanceof|import|export|from|default|async|await|yield|static|get|set|this|super|null|undefined|true|false)\b/g,
    java: /\b(public|private|protected|static|final|abstract|class|interface|extends|implements|return|if|else|for|while|do|switch|case|break|continue|try|catch|finally|throw|throws|new|import|package|void|int|long|double|float|boolean|char|byte|short|String|null|true|false|this|super)\b/g,
    python: /\b(def|class|return|if|elif|else|for|while|try|except|finally|raise|import|from|as|with|pass|break|continue|yield|lambda|and|or|not|in|is|None|True|False|self|async|await)\b/g,
    dotnet: /\b(public|private|protected|internal|static|readonly|const|class|interface|struct|enum|abstract|sealed|virtual|override|new|return|if|else|for|foreach|while|do|switch|case|break|continue|try|catch|finally|throw|using|namespace|void|int|long|double|float|bool|char|byte|string|object|null|true|false|this|base|var|async|await|get|set)\b/g,
  },
  // Common patterns
  string: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
  comment: /\/\/.*$|\/\*[\s\S]*?\*\/|#.*$/gm,
  number: /\b\d+\.?\d*([eE][+-]?\d+)?\b/g,
  decorator: /@\w+/g,
};

function highlightSyntax(line, language, searchTerms = []) {
  // First escape HTML
  let html = escapeHtml(line);

  // Track positions for non-overlapping replacements
  const replacements = [];

  // Helper to add replacement
  const addReplacement = (match, className, index) => {
    replacements.push({ start: index, end: index + match.length, html: `<span class="syn-${className}">${escapeHtml(match)}</span>` });
  };

  // Detect language
  const lang = (language || '').toLowerCase();
  const keywords = SYNTAX_PATTERNS.keywords[lang] || SYNTAX_PATTERNS.keywords.javascript;

  // Reset regex lastIndex
  SYNTAX_PATTERNS.string.lastIndex = 0;
  SYNTAX_PATTERNS.comment.lastIndex = 0;
  SYNTAX_PATTERNS.number.lastIndex = 0;
  SYNTAX_PATTERNS.decorator.lastIndex = 0;
  keywords.lastIndex = 0;

  // Collect matches (strings first - they take priority)
  let match;
  while ((match = SYNTAX_PATTERNS.string.exec(line)) !== null) {
    addReplacement(match[0], 'string', match.index);
  }
  while ((match = SYNTAX_PATTERNS.comment.exec(line)) !== null) {
    addReplacement(match[0], 'comment', match.index);
  }

  // Keywords (only if not inside string/comment)
  while ((match = keywords.exec(line)) !== null) {
    const overlaps = replacements.some(r => match.index >= r.start && match.index < r.end);
    if (!overlaps) {
      addReplacement(match[0], 'keyword', match.index);
    }
  }

  // Numbers (only if not inside string/comment/keyword)
  while ((match = SYNTAX_PATTERNS.number.exec(line)) !== null) {
    const overlaps = replacements.some(r => match.index >= r.start && match.index < r.end);
    if (!overlaps) {
      addReplacement(match[0], 'number', match.index);
    }
  }

  // Decorators (Python/Java annotations)
  if (lang === 'python' || lang === 'java') {
    while ((match = SYNTAX_PATTERNS.decorator.exec(line)) !== null) {
      const overlaps = replacements.some(r => match.index >= r.start && match.index < r.end);
      if (!overlaps) {
        addReplacement(match[0], 'decorator', match.index);
      }
    }
  }

  // Sort replacements by position (descending) and apply
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    html = html.slice(0, r.start) + r.html + html.slice(r.end);
  }

  // Highlight search terms (on top of syntax highlighting)
  for (const term of searchTerms) {
    if (term.length < 2) continue;
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const termRegex = new RegExp(`(${escapedTerm})`, 'gi');
    html = html.replace(termRegex, '<mark class="search-highlight">$1</mark>');
  }

  return html;
}

async function request(method, url, body, timeoutMs = 600000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(JSON.stringify(data, null, 2));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(timeoutMs/1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function pollTask(taskId, timeoutMs = 600000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const body = await request("GET", `/api/tasks/${encodeURIComponent(taskId)}`, undefined, 30000);
    const task = body.task;
    if (task?.status === "succeeded") return body;
    if (task?.status === "failed") {
      throw new Error(task.error?.message || `Task ${taskId} failed`);
    }
    await refreshServiceStatus();
    await refreshTaskCenter();
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Task ${taskId} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function submitIndexTask(payload) {
  const accepted = await request("POST", "/api/index-project", payload);
  await refreshTaskCenter();
  const taskId = accepted?.data?.taskId;
  if (!taskId) return accepted;
  return pollTask(taskId);
}

function parseSearchLanguages(value) {
  const allowed = new Set(["java", "javascript", "dotnet", "python", "markdown"]);
  return [...new Set(value.split(",").map(item => item.trim().toLowerCase()).filter(item => allowed.has(item)))];
}

function formatStatusTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatDataHealthStatus(dataHealth) {
  const labels = { degraded: "降级", ok: "正常", repairable: "可修复" };
  const status = dataHealth?.status || "ok";
  const checkCount = Array.isArray(dataHealth?.checks) ? dataHealth.checks.length : 0;
  return checkCount > 0 ? `${labels[status] || status} (${checkCount})` : (labels[status] || status);
}

function renderServiceStatus(health) {
  if (serviceVersionEl) serviceVersionEl.textContent = health?.version || "--";
  if (serviceWatchStatusEl) serviceWatchStatusEl.textContent = health?.watching ? "开启" : "关闭";
  if (serviceProjectsEl) {
    const total = health?.projects?.total ?? 0;
    const ready = health?.projects?.ready ?? 0;
    serviceProjectsEl.textContent = `${ready}/${total}`;
  }
  if (serviceLatestIndexEl) serviceLatestIndexEl.textContent = formatStatusTime(health?.index?.latestIndexAt);
  if (serviceActiveTasksEl) {
    const indexingCount = Array.isArray(health?.indexing) ? health.indexing.length : 0;
    const taskCount = Array.isArray(health?.tasks) ? health.tasks.length : 0;
    const activity = indexingCount + taskCount > 0 ? `${indexingCount} 索引 / ${taskCount} 摘要` : "空闲";
    serviceActiveTasksEl.textContent = `${activity} · 数据${formatDataHealthStatus(health?.dataHealth)}`;
  }
}

async function refreshServiceStatus() {
  try {
    renderServiceStatus(await request("GET", "/health"));
  } catch (err) {
    console.warn("Failed to load service status:", err);
  }
}

function formatTaskDuration(task) {
  const value = task?.durationMs ?? task?.elapsedMs;
  if (typeof value !== "number") return "--";
  if (value < 1000) return `${value}ms`;
  return `${Math.round(value / 100) / 10}s`;
}

function summarizeTaskResult(task) {
  const result = task?.result || {};
  if (task?.type === "index") {
    return {
      changedFiles: result.changedFiles,
      chunkCount: result.chunkCount,
      failedFileCount: result.failedFileCount,
      indexedFiles: result.indexedFiles,
      scannedFiles: result.scannedFiles,
    };
  }
  if (task?.type === "summary") {
    return {
      filesWritten: result.filesWritten,
      moduleCount: result.moduleCount,
      outputDir: result.outputDir,
      tokensUsed: result.tokensUsed,
    };
  }
  return result;
}

function renderTaskCenter(tasks) {
  if (!taskListEl) return;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    taskListEl.innerHTML = '<div class="task-empty">暂无任务</div>';
    return;
  }

  taskListEl.innerHTML = tasks.map((task) => {
    const result = summarizeTaskResult(task);
    const hasResult = task.status === "succeeded" && Object.keys(result).length > 0;
    const resultHtml = hasResult ? `<pre class="task-result">${escapeHtml(JSON.stringify(result, null, 2))}</pre>` : "";
    const errorHtml = task.error?.message ? `<p class="task-error">${escapeHtml(task.error.message)}</p>` : "";
    const cancelHtml = task.status === "running"
      ? `<button type="button" class="btn-secondary btn-small task-cancel" data-task-id="${escapeHtml(task.taskId)}">取消</button>`
      : "";
    return `
      <details class="task-item">
        <summary>
          <div class="task-row">
            <span class="task-badge">${escapeHtml(task.type || "--")}</span>
            <div class="task-main">
              <div class="task-project" title="${escapeHtml(task.projectRootPath || "")}">${escapeHtml(task.projectRootPath || "--")}</div>
              <div class="task-meta">${escapeHtml(formatStatusTime(task.startedAt))} · ${escapeHtml(formatTaskDuration(task))}</div>
            </div>
            <span class="task-status ${escapeHtml(task.status || "")}">${escapeHtml(task.status || "--")}</span>
          </div>
        </summary>
        <div class="task-details">
          <div class="task-detail-grid">
            <div><span>任务 ID</span><strong>${escapeHtml(task.taskId || "--")}</strong></div>
            <div><span>开始</span><strong>${escapeHtml(formatStatusTime(task.startedAt))}</strong></div>
            <div><span>结束</span><strong>${escapeHtml(formatStatusTime(task.completedAt))}</strong></div>
          </div>
          ${cancelHtml}
          ${errorHtml}
          ${resultHtml}
        </div>
      </details>`;
  }).join("");

  taskListEl.querySelectorAll(".task-cancel").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.getAttribute("data-task-id");
      if (!taskId) return;
      button.disabled = true;
      try {
        await request("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`);
      } finally {
        await refreshTaskCenter();
        await refreshServiceStatus();
      }
    });
  });
}

async function refreshTaskCenter() {
  if (!taskListEl) return;
  const params = new URLSearchParams();
  if (taskFilterTypeInput?.value) params.set("type", taskFilterTypeInput.value);
  if (taskFilterStatusInput?.value) params.set("status", taskFilterStatusInput.value);
  if (projectRootInput?.value?.trim()) params.set("projectRootPath", projectRootInput.value.trim());
  try {
    const body = await request("GET", `/api/tasks${params.toString() ? `?${params.toString()}` : ""}`);
    renderTaskCenter(body.tasks);
  } catch (err) {
    taskListEl.innerHTML = `<div class="task-empty">${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function setValueHint(input, max, label) {
  const hint = document.querySelector(`[data-value-hint="${input?.id}"]`);
  if (!input || !hint) return;
  const current = input.value || input.getAttribute("value") || "";
  hint.textContent = `${label || "当前"} ${current} / 最大 ${max}`;
}

function updateBoundedValueHints() {
  setValueHint(topKInput, TOP_K_MAX, "当前");
  setValueHint(includeContextLinesInput, MAX_INCLUDE_CONTEXT_LINES, "当前");
  setValueHint(snippetEndInput, FILE_SNIPPET_MAX_END_LINE, "结束行");
  setValueHint(qaMaxSourcesInput, QA_MAX_SOURCES, "当前");
  setValueHint(qaMaxContextTokensInput, QA_MAX_CONTEXT_TOKENS, "当前");
  setValueHint(qaMaxTokensInput, QA_MAX_TOKENS, "当前");
  setValueHint(qaTimeoutInput, QA_TIMEOUT_SECONDS_MAX, "当前");
  setValueHint(qaRetriesInput, QA_RETRIES_MAX, "当前");
}

function renderQaEffectiveParams(requestParams) {
  if (!qaEffectiveParamsEl) return;
  if (!requestParams) {
    qaEffectiveParamsEl.hidden = true;
    qaEffectiveParamsEl.innerHTML = "";
    return;
  }
  const items = [
    ["参考代码", requestParams.maxSources],
    ["上下文", requestParams.maxContextTokens],
    ["输出", requestParams.maxTokens || "默认"],
    ["超时", `${requestParams.timeoutSeconds}s`],
    ["重试", requestParams.retries],
    ["模式", requestParams.contextMode],
  ];
  qaEffectiveParamsEl.hidden = false;
  qaEffectiveParamsEl.innerHTML = items.map(([label, value]) =>
    `<span class="qa-effective-param"><strong>${escapeHtml(label)}</strong>${escapeHtml(String(value ?? "--"))}</span>`
  ).join("");
}

function describeSearchMatchSource(source) {
  const labels = {
    lexical: "文本命中",
    path: "路径命中",
    semantic: "语义召回",
    symbol: "符号命中",
  };
  return labels[source] || source;
}

function renderSearchMatchExplanation(source) {
  if (!source) return "";
  const chips = [];
  const explanation = source?.explanation || {};
  const matchedSources = Array.isArray(source.explanation?.matchedSources)
    ? source.explanation.matchedSources
    : String(source.reason || "").split("+").filter(Boolean);
  for (const matchedSource of matchedSources) {
    chips.push(describeSearchMatchSource(matchedSource));
  }
  if (source.explanation?.pathMatch) chips.push(`路径 ${source.explanation.pathMatch}`);
  if (source.explanation?.symbolMatch) chips.push(`符号 ${source.explanation.symbolMatch}`);
  if (source.explanation?.snippetMatch) chips.push("代码片段命中");
  if (source.explanation?.tokenCoverage) {
    const coverage = source.explanation.tokenCoverage;
    chips.push(`Token ${coverage.matched}/${coverage.total}`);
  }
  if (Array.isArray(source.explanation?.matchedTokens) && source.explanation.matchedTokens.length > 0) {
    chips.push(`关键词 ${source.explanation.matchedTokens.slice(0, 4).join(", ")}`);
  }
  if (source.score !== undefined) chips.push(`Score ${Number(source.score).toFixed(2)}`);
  if (chips.length === 0) return "";
  return `<div class="search-match-explanation" title="${escapeHtmlAttribute(JSON.stringify(explanation))}">
    <strong>为什么命中</strong>
    ${chips.map(chip => `<span class="search-match-chip">${escapeHtml(chip)}</span>`).join("")}
  </div>`;
}

function formatSourceReference(source) {
  const filePath = source?.filePath || "--";
  const startLine = Number(source?.startLine || 0);
  return startLine > 0 ? `${filePath}:${startLine}` : filePath;
}

function getProjectRootPath() {
  return String(projectRootInput?.value || "").trim();
}

function isAbsoluteSourcePath(filePath) {
  return String(filePath || "").startsWith("/") || /^[A-Za-z]:[\\/]/.test(String(filePath || ""));
}

function joinSourcePath(projectRootPath, filePath) {
  const sourcePath = String(filePath || "").trim();
  const rootPath = String(projectRootPath || "").trim();
  if (!sourcePath) return rootPath;
  if (isAbsoluteSourcePath(sourcePath) || !rootPath) return sourcePath;
  return `${rootPath.replace(/[\\/]+$/, "")}/${sourcePath.replace(/^[\\/]+/, "")}`;
}

function formatSourceAbsolutePath(source) {
  return joinSourcePath(getProjectRootPath(), source?.filePath || "");
}

function getSourceLine(source) {
  return Math.max(1, Number(source?.startLine || 1));
}

function formatSourceAbsoluteReference(source) {
  const absolutePath = formatSourceAbsolutePath(source);
  const startLine = Number(source?.startLine || 0);
  return startLine > 0 ? `${absolutePath}:${startLine}` : absolutePath;
}

function buildIdeDeepLink(source, kind) {
  const absolutePath = formatSourceAbsolutePath(source);
  if (!absolutePath) return "";
  const line = getSourceLine(source);
  if (kind === "idea") {
    const projectRootPath = getProjectRootPath();
    const query = new URLSearchParams({
      project: projectRootPath || absolutePath,
      path: absolutePath,
      line: String(line),
    });
    return `jetbrains://idea/navigate/reference?${query.toString()}`;
  }
  return `vscode://file/${absolutePath}:${line}`;
}

function buildAgentPrompt(source, agentKind) {
  const agentName = agentKind === "claude" ? "Claude Code" : "Codex";
  const absoluteReference = formatSourceAbsoluteReference(source);
  const sourceReference = formatSourceReference(source);
  const snippet = getSourceSnippetText(source);
  const lines = [
    `请用 ${agentName} 继续定位这段代码。`,
    `项目根目录：${getProjectRootPath() || "(未选择)"}`,
    `文件位置：${absoluteReference || sourceReference}`,
    `相对引用：${sourceReference}`,
  ];
  if (snippet) {
    lines.push("", "代码片段：", "```", snippet, "```");
  }
  return lines.join("\n");
}

function serializeSourceForBundle(source) {
  return JSON.stringify({
    endLine: source?.endLine,
    explanation: source?.explanation,
    filePath: source?.filePath || "",
    language: source?.language || "",
    reason: source?.reason || "",
    score: source?.score,
    snippet: getSourceSnippetText(source),
    startLine: source?.startLine,
  });
}

function renderSourceBundleSelector(source, id) {
  if (!source?.filePath) return "";
  return `<label class="source-bundle-selector" title="加入上下文包">
    <input type="checkbox" class="source-bundle-checkbox" data-bundle-source="${escapeHtmlAttribute(serializeSourceForBundle(source))}" data-bundle-source-id="${escapeHtmlAttribute(id)}" />
    <span>加入上下文包</span>
  </label>`;
}

function renderContextBundleToolbar(scope) {
  const presetButtons = CONTEXT_BUNDLE_TASK_PRESETS.map((preset) =>
    `<button type="button" class="context-bundle-preset" data-context-bundle-preset="${escapeHtmlAttribute(preset)}">${escapeHtml(preset)}</button>`
  ).join("");
  return `<div class="context-bundle-toolbar" data-context-bundle-scope="${escapeHtmlAttribute(scope)}">
    <strong>上下文包</strong>
    <div class="context-bundle-actions">
      <button type="button" class="context-bundle-action" data-context-bundle-action="copy">复制上下文包</button>
      <button type="button" class="context-bundle-action" data-context-bundle-action="copy" data-context-bundle-agent="codex">发送到 Codex</button>
      <button type="button" class="context-bundle-action" data-context-bundle-action="copy" data-context-bundle-agent="claude">发送到 Claude</button>
    </div>
    <div class="context-bundle-task">
      <textarea class="context-bundle-task-input" data-context-bundle-task rows="2" placeholder="任务说明（可选）"></textarea>
      <div class="context-bundle-presets">${presetButtons}</div>
    </div>
  </div>`;
}

function normalizeBundleSource(source) {
  return {
    endLine: source?.endLine,
    explanation: source?.explanation,
    filePath: source?.filePath || "",
    language: source?.language || "",
    reason: source?.reason || "",
    score: source?.score,
    snippet: getSourceSnippetText(source),
    startLine: source?.startLine,
  };
}

function describeBundleAgent(agentKind) {
  if (agentKind === "claude") return "Claude Code";
  if (agentKind === "codex") return "Codex";
  return "AI 助手";
}

function buildContextBundleMarkdown(sources, agentKind, taskDraft = "") {
  const items = Array.isArray(sources) ? sources.map(normalizeBundleSource).filter((source) => source.filePath) : [];
  const agentName = describeBundleAgent(agentKind);
  const taskText = String(taskDraft || "").trim();
  const lines = [
    `请用 ${agentName} 基于以下多文件上下文继续分析。`,
  ];
  if (taskText) lines.push(`任务说明：${taskText}`);
  lines.push(
    `项目根目录：${getProjectRootPath() || "(未选择)"}`,
    `共 ${items.length} 个代码片段`,
    "",
  );

  items.forEach((source, index) => {
    const absoluteReference = formatSourceAbsoluteReference(source);
    const sourceReference = formatSourceReference(source);
    lines.push(`## ${index + 1}. ${sourceReference}`);
    lines.push(`- Absolute: ${absoluteReference || sourceReference}`);
    lines.push(`- Reference: ${sourceReference}`);
    if (source.reason) lines.push(`- Reason: ${source.reason}`);
    if (source.score !== undefined) lines.push(`- Score: ${Number(source.score).toFixed(2)}`);
    if (Array.isArray(source.explanation?.matchedTokens) && source.explanation.matchedTokens.length > 0) {
      lines.push(`- Matched tokens: ${source.explanation.matchedTokens.join(", ")}`);
    }
    if (Array.isArray(source.explanation?.matchedSources) && source.explanation.matchedSources.length > 0) {
      lines.push(`- Matched sources: ${source.explanation.matchedSources.join(", ")}`);
    }
    if (source.explanation?.snippetMatch) lines.push("- Snippet match: true");
    if (source.snippet) {
      lines.push("", `\`\`\`${source.language || ""}`, source.snippet, "```");
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

function getSourceSnippetText(source) {
  return String(source?.snippet || "");
}

function hasSourceSnippet(source) {
  return getSourceSnippetText(source).trim().length > 0;
}

function renderSearchResultActions(source) {
  if (!source?.filePath) return "";
  const snippet = getSourceSnippetText(source);
  const absolutePath = formatSourceAbsolutePath(source);
  const vscodeUrl = buildIdeDeepLink(source, "vscode");
  const ideaUrl = buildIdeDeepLink(source, "idea");
  const snippetButton = hasSourceSnippet(source)
    ? `<button type="button" class="search-result-action" data-copy-kind="snippet" data-source-snippet="${escapeHtmlAttribute(snippet)}" title="复制代码片段">复制片段</button>`
    : "";
  return `<div class="search-result-actions">
    <button type="button" class="search-result-action" data-copy-kind="path" data-source-path="${escapeHtmlAttribute(source.filePath)}" title="复制文件路径">复制路径</button>
    <button type="button" class="search-result-action" data-copy-kind="reference" data-source-reference="${escapeHtmlAttribute(formatSourceReference(source))}" title="复制 path:line 引用">复制引用</button>
    <button type="button" class="search-result-action" data-copy-kind="absolute" data-source-absolute-path="${escapeHtmlAttribute(absolutePath)}" title="复制绝对路径">复制绝对路径</button>
    <button type="button" class="search-result-ide-action" data-ide-kind="vscode" data-ide-url="${escapeHtmlAttribute(vscodeUrl)}" title="在 VS Code 中打开当前文件行">打开 VS Code</button>
    <button type="button" class="search-result-ide-action" data-ide-kind="idea" data-ide-url="${escapeHtmlAttribute(ideaUrl)}" title="在 IntelliJ IDEA 中打开当前文件行">打开 IDEA</button>
    <button type="button" class="search-result-action" data-copy-kind="codex" data-agent-prompt="${escapeHtmlAttribute(buildAgentPrompt(source, "codex"))}" title="复制 Codex 交接提示词">发送到 Codex</button>
    <button type="button" class="search-result-action" data-copy-kind="claude" data-agent-prompt="${escapeHtmlAttribute(buildAgentPrompt(source, "claude"))}" title="复制 Claude Code 交接提示词">发送到 Claude</button>
    ${snippetButton}
  </div>`;
}

function buildLazyContextRange(source) {
  const startLine = Math.max(1, Number(source?.startLine || 1));
  const endLine = Math.max(startLine, Number(source?.endLine || startLine));
  return {
    startLine: Math.max(1, startLine - LAZY_CONTEXT_LINES),
    endLine: endLine + LAZY_CONTEXT_LINES,
  };
}

function renderLazyContextAction(source) {
  if (!source?.filePath) return "";
  const range = buildLazyContextRange(source);
  return `<div class="lazy-context-panel">
    <button type="button"
      class="lazy-context-action"
      data-context-action="load"
      data-context-file-path="${escapeHtmlAttribute(source.filePath)}"
      data-context-start-line="${range.startLine}"
      data-context-end-line="${range.endLine}"
      data-context-language="${escapeHtmlAttribute(source.language || "")}"
      title="按需加载更大范围的代码上下文">更多上下文</button>
    <div class="lazy-context-preview" hidden></div>
  </div>`;
}

function renderSearchResultExplanations(results) {
  const items = Array.isArray(results) ? results.slice(0, 5) : [];
  if (items.length === 0) return "";
  return `<div class="search-result-explanations">
    <div class="search-result-explanations-header">
      <strong>搜索结果命中解释</strong>
      <div class="search-explanations-controls">
        <button type="button" class="search-explanations-toggle" data-explanation-action="expand">展开全部</button>
        <button type="button" class="search-explanations-toggle" data-explanation-action="collapse">收起全部</button>
      </div>
    </div>
    ${renderContextBundleToolbar("search")}
    ${items.map((item, index) => `<div class="search-result-explanation">
      <span class="search-result-explanation-index">#${index + 1}</span>
      <span class="search-result-explanation-path">${escapeHtml(item.filePath || "--")}</span>
      ${renderSourceBundleSelector(item, `search-${index}`)}
      ${renderSearchResultActions(item)}
      ${renderLazyContextAction(item)}
      ${renderSearchMatchExplanation(item)}
    </div>`).join("")}
  </div>`;
}

function renderProjectProfileSummary(profile) {
  const suggestions = profile?.diagnostics?.suggestions || [];
  const dataHealthSuggestions = profile?.dataHealth?.suggestions || [];
  const suggestionLabels = {
    CHECK_PROJECT_PATH: "检查路径",
    RUN_FULL_INDEX: "全量索引",
    RUN_DOCTOR: "运行自检",
    GENERATE_SUMMARY: "生成摘要",
    WARM_VECTOR_INDEX: "预热向量",
    REINDEX_FOR_SYMBOLS: "重建符号",
    REVIEW_FAILED_FILES: "检查失败文件",
  };
  const languages = Array.isArray(profile?.languages) && profile.languages.length > 0
    ? profile.languages.slice(0, 4).map((item) => `${item.language}:${item.fileCount}`).join(" / ")
    : "--";
  const vectorCoverage = profile?.vector?.coverage || {};
  const vectorPercent = vectorCoverage.totalChunkCount > 0
    ? `${Math.round((vectorCoverage.coverageRatio || 0) * 100)}%`
    : "--";
  const cards = [
    { label: "画像状态", value: profile?.diagnostics?.status || "--" },
    { label: "数据健康", value: formatDataHealthStatus(profile?.dataHealth) },
    { label: "文件", value: String(profile?.counts?.fileCount ?? 0) },
    { label: "代码块", value: String(profile?.counts?.chunkCount ?? 0) },
    { label: "符号", value: String(profile?.counts?.symbolCount ?? 0) },
    { label: "语言", value: languages },
    { label: "摘要", value: profile?.summary?.found ? `${profile.summary.moduleCount} 模块` : "未生成" },
    { label: "向量覆盖", value: `${vectorPercent} (${vectorCoverage.indexedChunkCount ?? 0}/${vectorCoverage.totalChunkCount ?? 0})` },
    { label: "最近索引", value: formatStatusTime(profile?.timestamps?.lastIndexAt) },
  ];
  const cardHtml = cards.map(card =>
    `<div class="result-summary-card"><strong>${escapeHtml(card.label)}</strong><span>${escapeHtml(card.value)}</span></div>`
  ).join("");
  const suggestionHtml = suggestions.length > 0
    ? `<div class="diagnostic-suggestions">${suggestions.map((suggestion) => {
      const label = suggestionLabels[suggestion.code] || suggestion.code;
      return `<span class="diagnostic-suggestion ${escapeHtml(suggestion.severity || "info")}"><strong>${escapeHtml(label)}</strong>${escapeHtml(suggestion.label || "")}<button type="button" class="btn-secondary btn-small profile-fix-action" data-profile-fix="${escapeHtml(suggestion.code)}">${escapeHtml(label)}</button></span>`;
    }).join("")}</div>`
    : "";
  const dataHealthHtml = dataHealthSuggestions.length > 0
    ? `<div class="diagnostic-suggestions data-health-suggestions">${dataHealthSuggestions.map((suggestion) => {
      const label = suggestionLabels[suggestion.code] || suggestion.code;
      return `<span class="diagnostic-suggestion ${escapeHtml(suggestion.severity || "info")}"><strong>${escapeHtml(label)}</strong>${escapeHtml(suggestion.label || "")}</span>`;
    }).join("")}</div>`
    : "";
  return `${cardHtml}${dataHealthHtml}${suggestionHtml}`;
}

async function refreshProjectProfile(projectRootPath) {
  const profile = await request("GET", "/api/project-profile?projectRootPath=" + encodeURIComponent(projectRootPath));
  render(profile);
  return profile;
}

function summarizeProjectProfile(profile) {
  const vectorCoverage = profile?.vector?.coverage || {};
  return {
    chunkCount: Number(profile?.counts?.chunkCount ?? 0),
    fileCount: Number(profile?.counts?.fileCount ?? 0),
    summaryModules: Number(profile?.summary?.moduleCount ?? 0),
    summaryStatus: profile?.summary?.found ? "已生成" : "未生成",
    symbolCount: Number(profile?.counts?.symbolCount ?? 0),
    vectorIndexed: Number(vectorCoverage.indexedChunkCount ?? 0),
    vectorTotal: Number(vectorCoverage.totalChunkCount ?? 0),
  };
}

function diffProjectProfile(beforeSummary, afterSummary) {
  return [
    { label: "文件", before: beforeSummary.fileCount, after: afterSummary.fileCount },
    { label: "代码块", before: beforeSummary.chunkCount, after: afterSummary.chunkCount },
    { label: "符号", before: beforeSummary.symbolCount, after: afterSummary.symbolCount },
    { label: "向量", before: `${beforeSummary.vectorIndexed}/${beforeSummary.vectorTotal}`, after: `${afterSummary.vectorIndexed}/${afterSummary.vectorTotal}` },
    { label: "摘要", before: beforeSummary.summaryStatus, after: afterSummary.summaryStatus },
  ];
}

function formatDeltaValue(before, after) {
  if (typeof before === "number" && typeof after === "number") {
    const delta = after - before;
    if (delta > 0) return `+${delta}`;
    return String(delta);
  }
  return before === after ? "无变化" : "已变化";
}

function renderFailedFileDetails(failedFiles, projectRootPath) {
  const files = Array.isArray(failedFiles) ? failedFiles : [];
  if (files.length === 0) {
    return `<div class="failed-file-detail empty">暂无失败文件</div>`;
  }
  return `<div class="failed-file-details">
    <div class="failed-file-header">失败文件明细 · ${escapeHtml(String(files.length))}</div>
    ${files.map((file) => {
      const filePath = String(typeof file === "string" ? file : (file.filePath || file.path || file.relativePath || "--"));
      const error = String(typeof file === "string" ? "" : (file.message || file.error || file.reason || ""));
      const displayPath = projectRootPath && filePath.startsWith(projectRootPath)
        ? filePath.slice(projectRootPath.length).replace(/^\/+/, "")
        : filePath;
      return `<div class="failed-file-detail">
        <div class="failed-file-path mono" title="${escapeHtml(filePath)}">${escapeHtml(displayPath || filePath)}</div>
        ${error ? `<div class="failed-file-error">${escapeHtml(error)}</div>` : ""}
        <button type="button" class="btn-secondary btn-small copy-failed-file-path" data-copy-path="${escapeHtml(filePath)}">复制路径</button>
      </div>`;
    }).join("")}
  </div>`;
}

function renderProfileRepairResult(code, beforeProfile, afterProfile, taskResult) {
  const beforeSummary = summarizeProjectProfile(beforeProfile);
  const afterSummary = summarizeProjectProfile(afterProfile || beforeProfile);
  const task = taskResult?.task || taskResult;
  const taskStatus = task?.status || (code === "REVIEW_FAILED_FILES" ? "ready" : "done");
  const durationMs = task?.durationMs ?? task?.elapsedMs;
  const deltas = diffProjectProfile(beforeSummary, afterSummary);
  const failedFiles = code === "REVIEW_FAILED_FILES"
    ? beforeProfile?.latestIndexing?.failedFiles || []
    : afterProfile?.latestIndexing?.failedFiles || [];
  const projectRootPath = beforeProfile?.projectRootPath || afterProfile?.projectRootPath || "";
  return `<div class="profile-repair-result">
    <div class="profile-repair-header">
      <strong>修复结果</strong>
      <span>${escapeHtml(code || "--")} · ${escapeHtml(taskStatus)} · ${escapeHtml(formatTaskDuration({ durationMs }))}</span>
    </div>
    <div class="profile-repair-deltas">
      ${deltas.map((item) => `<div class="profile-repair-delta">
        <strong>${escapeHtml(item.label)}</strong>
        <span>${escapeHtml(String(item.before))} → ${escapeHtml(String(item.after))}</span>
        <em>${escapeHtml(formatDeltaValue(item.before, item.after))}</em>
      </div>`).join("")}
    </div>
    ${code === "REVIEW_FAILED_FILES" ? renderFailedFileDetails(failedFiles, projectRootPath) : ""}
  </div>`;
}

function bindFailedFileCopyActions() {
  if (!resultSummaryEl) return;
  resultSummaryEl.querySelectorAll(".copy-failed-file-path").forEach((button) => {
    button.addEventListener("click", () => {
      const filePath = button.getAttribute("data-copy-path") || "";
      copyText(filePath);
    });
  });
}

function copyText(filePath) {
  return copyTextToClipboard(filePath);
}

function bindSearchResultActions() {
  document.querySelectorAll(".search-result-action").forEach((button) => {
    if (button.dataset.searchActionBound === "1") return;
    button.dataset.searchActionBound = "1";
    button.addEventListener("click", () => {
      const kind = button.getAttribute("data-copy-kind");
      const value = kind === "reference"
        ? button.getAttribute("data-source-reference")
        : kind === "snippet"
          ? button.getAttribute("data-source-snippet")
          : kind === "absolute"
            ? button.getAttribute("data-source-absolute-path")
            : kind === "codex" || kind === "claude"
              ? button.getAttribute("data-agent-prompt")
              : button.getAttribute("data-source-path");
      if (!value) return;
      copyTextToClipboard(value, button);
    });
  });
}

function bindSearchIdeActions() {
  document.querySelectorAll(".search-result-ide-action").forEach((button) => {
    if (button.dataset.searchIdeActionBound === "1") return;
    button.dataset.searchIdeActionBound = "1";
    button.addEventListener("click", () => {
      const url = button.getAttribute("data-ide-url") || "";
      if (!url) return;
      window.location.href = url;
    });
  });
}

function collectSelectedBundleSources(root = document) {
  return Array.from(root.querySelectorAll(".source-bundle-checkbox:checked"))
    .map((input) => {
      try {
        return JSON.parse(input.getAttribute("data-bundle-source") || "{}");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getContextBundleTaskDraft(root) {
  const input = root?.querySelector?.("[data-context-bundle-task]");
  return String(input?.value || "").trim();
}

function applyContextBundleTaskPreset(button) {
  const preset = button.getAttribute("data-context-bundle-preset") || "";
  const toolbar = button.closest(".context-bundle-toolbar");
  const input = toolbar?.querySelector("[data-context-bundle-task]");
  if (!input || !preset) return;
  input.value = preset;
  if (typeof input.focus === "function") input.focus();
}

function bindContextBundleActions() {
  document.querySelectorAll(".context-bundle-preset").forEach((button) => {
    if (button.dataset.contextBundlePresetBound === "1") return;
    button.dataset.contextBundlePresetBound = "1";
    button.addEventListener("click", () => applyContextBundleTaskPreset(button));
  });
  document.querySelectorAll(".context-bundle-action").forEach((button) => {
    if (button.dataset.contextBundleBound === "1") return;
    button.dataset.contextBundleBound = "1";
    button.addEventListener("click", () => {
      const toolbar = button.closest(".context-bundle-toolbar");
      const container = toolbar?.parentElement || document;
      const selectedSources = collectSelectedBundleSources(container);
      const markdown = buildContextBundleMarkdown(selectedSources, button.getAttribute("data-context-bundle-agent") || "", getContextBundleTaskDraft(toolbar));
      if (!markdown) return;
      copyTextToClipboard(markdown, button);
    });
  });
}

function bindSearchExplanationToggles() {
  if (!resultSummaryEl) return;
  resultSummaryEl.querySelectorAll(".search-explanations-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-explanation-action");
      resultSummaryEl.querySelectorAll(".search-result-explanation").forEach((item) => {
        item.classList.toggle("search-explanations-collapsed", action === "collapse");
      });
    });
  });
}

function renderLazyContextSnippet(snippet, startLine, endLine, language) {
  const lines = String(snippet || "").split("\n");
  if (lines.length === 1 && lines[0] === "") {
    return `<div class="lazy-context-empty">没有读取到代码片段</div>`;
  }
  const body = lines.map((line, index) =>
    `<div class="snippet-line"><span class="snippet-linenum">${startLine + index}</span>${highlightSyntax(line, language, [])}</div>`
  ).join("");
  return `<div class="lazy-context-meta">上下文 L${startLine}-${endLine}</div>
  <div class="lazy-context-snippet">${body}</div>`;
}

async function loadLazyContextPreview(button) {
  const panel = button.closest(".lazy-context-panel");
  const preview = panel?.querySelector(".lazy-context-preview");
  if (!preview) return;
  button.disabled = true;
  button.textContent = "加载中...";
  preview.hidden = false;
  preview.innerHTML = `<div class="lazy-context-meta">正在读取更多上下文...</div>`;
  try {
    const response = await request("POST", "/api/file-snippet", {
      projectRootPath: projectRootInput.value.trim(),
      filePath: button.getAttribute("data-context-file-path"),
      startLine: Number(button.getAttribute("data-context-start-line") || 1),
      endLine: Number(button.getAttribute("data-context-end-line") || 1),
    });
    const startLine = Number(response?.meta?.snippet?.startLine || button.getAttribute("data-context-start-line") || 1);
    const endLine = Number(response?.meta?.snippet?.endLine || button.getAttribute("data-context-end-line") || startLine);
    preview.innerHTML = renderLazyContextSnippet(
      response?.data?.snippet || "",
      startLine,
      endLine,
      button.getAttribute("data-context-language") || "",
    );
    button.textContent = "刷新上下文";
  } catch (err) {
    preview.innerHTML = `<div class="lazy-context-error">${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    button.textContent = "重试上下文";
  } finally {
    button.disabled = false;
  }
}

function bindLazyContextActions() {
  document.querySelectorAll(".lazy-context-action").forEach((button) => {
    if (button.dataset.lazyContextBound === "1") return;
    button.dataset.lazyContextBound = "1";
    button.addEventListener("click", () => loadLazyContextPreview(button));
  });
}

async function runProjectProfileFix(code, profile) {
  const projectRootPath = profile?.projectRootPath || projectRootInput.value?.trim();
  if (!projectRootPath) throw new Error("projectRootPath is required");
  const beforeProfile = profile;
  let afterResponse;
  let taskResult;

  if (code === "RUN_FULL_INDEX") {
    taskResult = await submitIndexTask({ mode: "full", projectRootPath });
    await refreshTaskCenter();
    afterResponse = await refreshProjectProfile(projectRootPath);
  } else if (code === "GENERATE_SUMMARY") {
    const accepted = await request("POST", "/api/summary/generate", { projectRootPath });
    const taskId = accepted?.data?.taskId;
    taskResult = taskId ? await pollTask(taskId) : accepted;
    await refreshTaskCenter();
    afterResponse = await refreshProjectProfile(projectRootPath);
  } else if (code === "WARM_VECTOR_INDEX") {
    taskResult = await request("POST", "/api/index/warm", { projectRootPath });
    await refreshTaskCenter();
    afterResponse = await refreshProjectProfile(projectRootPath);
  } else if (code === "REVIEW_FAILED_FILES") {
    afterResponse = {
      data: beforeProfile,
      failedFiles: beforeProfile?.latestIndexing?.failedFiles || [],
      projectRootPath,
    };
  } else {
    afterResponse = await refreshProjectProfile(projectRootPath);
  }

  const afterProfile = afterResponse?.data || afterResponse;
  return {
    ...afterResponse,
    data: afterProfile,
    profileRepair: {
      afterSummary: summarizeProjectProfile(afterProfile),
      beforeSummary: summarizeProjectProfile(beforeProfile),
      code,
      durationMs: taskResult?.task?.durationMs ?? taskResult?.task?.elapsedMs,
      failedFiles: afterProfile?.latestIndexing?.failedFiles || [],
      taskStatus: taskResult?.task?.status || "done",
    },
    summaryHtml: renderProfileRepairResult(code, beforeProfile, afterProfile, taskResult),
  };
}

function bindProjectProfileActions(payload) {
  if (!resultSummaryEl) return;
  resultSummaryEl.querySelectorAll(".profile-fix-action").forEach((button) => {
    button.addEventListener("click", () => run(async () => {
      const code = button.getAttribute("data-profile-fix");
      if (!code) return payload;
      return runProjectProfileFix(code, payload);
    }));
  });
}

function render(data) {
  renderSummary(data);
  resultEl.textContent = JSON.stringify(data, null, 2);
}

function renderSummary(data) {
  if (!resultSummaryEl) return;

  const cards = [];
  const stats = data?.stats || {};
  const payload = data?.data || {};
  const diagnostics = payload?.diagnostics || {};
  const vectorIndex = diagnostics?.vectorIndex || stats?.indexSync?.vectorIndex;

  if (data?.summaryHtml) {
    resultSummaryEl.hidden = false;
    resultSummaryEl.innerHTML = data.summaryHtml;
    bindFailedFileCopyActions();
    bindSearchResultActions();
    bindSearchIdeActions();
    bindContextBundleActions();
    bindSearchExplanationToggles();
    bindLazyContextActions();
    return;
  }

  if (payload?.diagnostics?.suggestions && payload?.counts && payload?.vector && payload?.summary) {
    resultSummaryEl.hidden = false;
    resultSummaryEl.innerHTML = renderProjectProfileSummary(payload);
    bindProjectProfileActions(payload);
    bindSearchResultActions();
    bindSearchIdeActions();
    bindContextBundleActions();
    bindSearchExplanationToggles();
    bindLazyContextActions();
    return;
  }

  if (stats?.search?.resultCount ?? stats?.resultCount) {
    cards.push({ label: "Results", value: String(stats.search?.resultCount ?? stats.resultCount) });
  }
  if (stats?.search?.searchMs ?? stats?.searchMs) {
    cards.push({ label: "Search ms", value: String(stats.search?.searchMs ?? stats.searchMs) });
  }
  if (stats?.search?.candidateCount ?? diagnostics?.candidateCount) {
    cards.push({ label: "Candidates", value: String(stats.search?.candidateCount ?? diagnostics.candidateCount) });
  }
  if (stats?.project?.fileCount ?? stats?.project?.indexedFileCount) {
    cards.push({ label: "Indexed files", value: String(stats.project?.indexedFileCount ?? stats.project?.fileCount) });
  }
  if (stats?.indexSync?.timings?.totalMs) {
    cards.push({ label: "Index total ms", value: String(stats.indexSync.timings.totalMs) });
  }
  if (vectorIndex?.enabled !== undefined) {
    const mode = vectorIndex.mode ? ` (${vectorIndex.mode})` : "";
    const hydrated = vectorIndex.hydratedChunkCount ? `, hydrated ${vectorIndex.hydratedChunkCount}` : "";
    cards.push({ label: "Vector index", value: `${vectorIndex.enabled ? "on" : "off"}${mode}${hydrated}` });
  }
  const explanationHtml = renderSearchResultExplanations(payload.results);

  if (cards.length === 0) {
    resultSummaryEl.hidden = explanationHtml === "";
    resultSummaryEl.innerHTML = explanationHtml;
    bindSearchResultActions();
    bindSearchIdeActions();
    bindContextBundleActions();
    bindSearchExplanationToggles();
    bindLazyContextActions();
    return;
  }

  resultSummaryEl.hidden = false;
  resultSummaryEl.innerHTML = cards.map(card =>
    `<div class="result-summary-card"><strong>${escapeHtml(card.label)}</strong><span>${escapeHtml(card.value)}</span></div>`
  ).join("") + explanationHtml;
  bindSearchResultActions();
  bindSearchIdeActions();
  bindContextBundleActions();
  bindSearchExplanationToggles();
  bindLazyContextActions();
}

async function run(action) {
  resultEl.textContent = "Loading...";
  if (resultSummaryEl) {
    resultSummaryEl.hidden = true;
    resultSummaryEl.innerHTML = "";
  }
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

document.getElementById("load-health")?.addEventListener("click", () => run(async () => {
  const health = await request("GET", "/health");
  renderServiceStatus(health);
  return health;
}));
document.getElementById("load-runtime")?.addEventListener("click", () => run(() => request("GET", "/api/runtime")));
document.getElementById("load-config")?.addEventListener("click", () => run(() => request("GET", "/api/config")));
document.getElementById("load-tools")?.addEventListener("click", () => run(() => request("GET", "/api/tools")));
document.getElementById("load-projects")?.addEventListener("click", () => run(async () => {
  const data = await request("GET", "/api/projects");
  // v4.2.6: Merge server projects with local storage
  if (data.projects) {
    for (const p of data.projects) {
      addStoredProject(p.projectRootPath, p.fileCount);
    }
    renderProjectSelect();
  }
  return data;
}));

projectRootSelect?.addEventListener("change", async () => {
  if (projectRootSelect.value) {
    projectRootInput.value = projectRootSelect.value;
    setSelectedProject(projectRootSelect.value);

    // v4.2.8: Auto-preload index when project is selected
    const projectPath = projectRootSelect.value;
    const selectEl = projectRootSelect;
    const originalText = selectEl.options[selectEl.selectedIndex]?.text || '';

    // Show loading state in select
    if (selectEl.options[selectEl.selectedIndex]) {
      selectEl.options[selectEl.selectedIndex].text = '⏳ 加载索引中...';
    }

    try {
      const result = await submitIndexTask({
        mode: "incremental",
        projectRootPath: projectPath
      });

      // Update file count if available
      const fileCount = result?.task?.result?.indexedFiles || result?.stats?.project?.indexedFileCount || result?.data?.indexedFiles;
      if (fileCount) {
        addStoredProject(projectPath, fileCount);
        renderProjectSelect();
        // Re-select the project
        projectRootSelect.value = projectPath;
        projectRootInput.value = projectPath;
      } else {
        // Restore original text
        if (selectEl.options[selectEl.selectedIndex]) {
          selectEl.options[selectEl.selectedIndex].text = originalText;
        }
      }

      console.log('Index preloaded for:', projectPath);
    } catch (err) {
      console.warn('Failed to preload index:', err);
      // Restore original text on error
      if (selectEl.options[selectEl.selectedIndex]) {
        selectEl.options[selectEl.selectedIndex].text = originalText;
      }
    }
  }
});

// v4.2.6: Initialize project select from LocalStorage on page load
renderProjectSelect();
refreshServiceStatus();
refreshTaskCenter();

document.getElementById("refresh-tasks")?.addEventListener("click", () => refreshTaskCenter());
[taskFilterTypeInput, taskFilterStatusInput].forEach(input => input?.addEventListener("change", refreshTaskCenter));

// v4.4.1: Auto-sync project list from backend on page load
(async function syncProjectsOnStartup() {
  try {
    const data = await request("GET", "/api/projects");
    if (data.projects) {
      for (const p of data.projects) {
        addStoredProject(p.projectRootPath, 0);
      }
      renderProjectSelect();
    }
  } catch (err) {
    console.warn('Failed to sync projects on startup:', err);
  }
})();

// v4.2.8: Auto-preload index on page load if a project is selected
(async function preloadOnStartup() {
  const selectedProject = getSelectedProject();
  if (selectedProject && projectRootInput) {
    console.log('Auto-preloading index for:', selectedProject);
    try {
      await submitIndexTask({
        mode: "incremental",
        projectRootPath: selectedProject
      });
      console.log('Index preloaded successfully');
    } catch (err) {
      console.warn('Failed to preload index on startup:', err);
    }
  }
})();

document.getElementById("run-index")?.addEventListener("click", () => run(async () => {
  const payload = {
    mode: indexModeInput.value,
    projectRootPath: projectRootInput.value
  };
  let result;
  try {
    result = await submitIndexTask(payload);
  } catch (error) {
    if (error?.status === 409 && error?.data?.code === "PARENT_DIRECTORY_REQUIRES_CONFIRMATION") {
      const childCount = Array.isArray(error.data.childProjects) ? error.data.childProjects.length : 0;
      const confirmed = window.confirm(`该目录包含 ${childCount} 个已登记子项目，全量索引可能非常耗时。确认继续？`);
      if (!confirmed) throw error;
      result = await submitIndexTask({ ...payload, confirmParentDirectory: true });
    } else {
      throw error;
    }
  }
  // Sync project to list after indexing
  const projectPath = projectRootInput.value?.trim();
  if (projectPath) {
    const fileCount = result?.task?.result?.indexedFiles ?? result?.data?.indexedFiles ?? result?.stats?.indexSync?.indexedFiles ?? 0;
    addStoredProject(projectPath, fileCount);
    renderProjectSelect();
  }
  return result;
}));

document.getElementById("run-stats")?.addEventListener("click", () => run(() => request(
  "GET",
  "/api/project-stats?projectRootPath=" + encodeURIComponent(projectRootInput.value)
)));

document.getElementById("run-project-profile")?.addEventListener("click", () => run(() => request(
  "GET",
  "/api/project-profile?projectRootPath=" + encodeURIComponent(projectRootInput.value)
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

includeContextLinesInput?.setAttribute("max", String(MAX_INCLUDE_CONTEXT_LINES));
qaMaxSourcesInput?.setAttribute("max", String(QA_MAX_SOURCES));
qaMaxContextTokensInput?.setAttribute("max", String(QA_MAX_CONTEXT_TOKENS));
qaMaxTokensInput?.setAttribute("max", String(QA_MAX_TOKENS));
qaTimeoutInput?.setAttribute("max", String(QA_TIMEOUT_SECONDS_MAX));
qaRetriesInput?.setAttribute("max", String(QA_RETRIES_MAX));
updateBoundedValueHints();

[topKInput, includeContextLinesInput, snippetEndInput, qaMaxSourcesInput, qaMaxContextTokensInput, qaMaxTokensInput, qaTimeoutInput, qaRetriesInput]
  .forEach(input => input?.addEventListener("input", updateBoundedValueHints));

document.getElementById("top-k-max")?.addEventListener("click", () => {
  if (topKInput) topKInput.value = String(TOP_K_MAX);
  updateBoundedValueHints();
});

document.getElementById("include-context-lines-max")?.addEventListener("click", () => {
  if (includeContextLinesInput) includeContextLinesInput.value = String(MAX_INCLUDE_CONTEXT_LINES);
  updateBoundedValueHints();
});

document.getElementById("snippet-range-max")?.addEventListener("click", () => {
  if (snippetStartInput) snippetStartInput.value = "1";
  if (snippetEndInput) snippetEndInput.value = String(FILE_SNIPPET_MAX_END_LINE);
  updateBoundedValueHints();
});

document.getElementById("qa-max-sources-max")?.addEventListener("click", () => {
  if (qaMaxSourcesInput) qaMaxSourcesInput.value = String(QA_MAX_SOURCES);
  updateBoundedValueHints();
});

document.getElementById("qa-max-context-tokens-max")?.addEventListener("click", () => {
  if (qaMaxContextTokensInput) qaMaxContextTokensInput.value = String(QA_MAX_CONTEXT_TOKENS);
  updateBoundedValueHints();
});

document.getElementById("qa-max-tokens-max")?.addEventListener("click", () => {
  if (qaMaxTokensInput) qaMaxTokensInput.value = String(QA_MAX_TOKENS);
  updateBoundedValueHints();
});

document.getElementById("qa-timeout-max")?.addEventListener("click", () => {
  if (qaTimeoutInput) qaTimeoutInput.value = String(QA_TIMEOUT_SECONDS_MAX);
  updateBoundedValueHints();
});

document.getElementById("qa-retries-max")?.addEventListener("click", () => {
  if (qaRetriesInput) qaRetriesInput.value = String(QA_RETRIES_MAX);
  updateBoundedValueHints();
});

// LLM Config
document.getElementById("load-llm-config")?.addEventListener("click", () => run(() => request("GET", "/api/llm/config")));
document.getElementById("update-llm-config")?.addEventListener("click", () => run(() => {
  const body = {};
  const url = document.getElementById("llm-api-url")?.value?.trim();
  const key = document.getElementById("llm-api-key")?.value?.trim();
  const model = document.getElementById("llm-model")?.value?.trim();
  if (url) body.apiUrl = url;
  if (key) body.apiKey = key;
  if (model) body.model = model;
  return request("POST", "/api/llm/config", body);
}));

// Summary
document.getElementById("run-generate-summary")?.addEventListener("click", () => run(async () => {
  const accepted = await request("POST", "/api/summary/generate", {
    projectRootPath: projectRootInput.value
  });
  await refreshTaskCenter();
  render(accepted);
  const taskId = accepted?.data?.taskId;
  if (!taskId) return accepted;
  return pollTask(taskId);
}));
document.getElementById("load-summary")?.addEventListener("click", () => run(() => request(
  "GET",
  "/api/summary?projectRootPath=" + encodeURIComponent(projectRootInput.value)
)));

// Autostart
const autostartBadge = document.getElementById("autostart-badge");
const autostartPlatform = document.getElementById("autostart-platform");

async function loadAutostartStatus() {
  try {
    const data = await request("GET", "/api/autostart");
    if (autostartBadge) {
      autostartBadge.textContent = data.enabled ? (data.running ? "运行中" : "已启用") : "已禁用";
      autostartBadge.className = "autostart-badge " + (data.enabled ? (data.running ? "running" : "enabled") : "disabled");
    }
    if (autostartPlatform) {
      autostartPlatform.textContent = data.platform + (data.webPort ? ` (端口 ${data.webPort})` : "");
    }
  } catch (err) {
    if (autostartBadge) {
      autostartBadge.textContent = "检查失败";
      autostartBadge.className = "autostart-badge disabled";
    }
  }
}

document.getElementById("autostart-enable")?.addEventListener("click", async () => {
  try {
    await request("POST", "/api/autostart", { action: "enable" });
    alert("开机自启动已启用！下次系统启动时服务会自动运行。");
    loadAutostartStatus();
  } catch (err) {
    alert("启用失败: " + (err.message || err));
  }
});

document.getElementById("autostart-disable")?.addEventListener("click", async () => {
  try {
    await request("POST", "/api/autostart", { action: "disable" });
    alert("开机自启动已禁用");
    loadAutostartStatus();
  } catch (err) {
    alert("禁用失败: " + (err.message || err));
  }
});

// Load autostart status on page load
loadAutostartStatus();

// ── v4.2.6: Add Project button with LocalStorage persistence ────────────────
document.getElementById("add-project")?.addEventListener("click", async () => {
  const addBtn = document.getElementById("add-project");
  const projectPath = projectRootInput.value?.trim();

  if (!projectPath) {
    alert("请先输入项目路径");
    return;
  }

  // Validate path format (basic check)
  if (!projectPath.startsWith("/") && !projectPath.match(/^[A-Z]:\\/i)) {
    alert("请输入绝对路径（如 /Users/me/project 或 C:\\projects\\myapp）");
    return;
  }

  addBtn.disabled = true;
  addBtn.textContent = "Indexing...";

  try {
    // Index the project with full mode for new projects
    const result = await submitIndexTask({
      projectRootPath: projectPath,
      mode: "full"
    });

    // Show success message
    const indexResult = result?.task?.result ?? result?.data ?? {};
    const fileCount = indexResult.indexedFiles ?? result?.stats?.indexSync?.indexedFiles ?? 0;
    const chunkCount = indexResult.chunkCount ?? result?.stats?.indexSync?.chunkCount ?? 0;
    alert(`✅ 项目索引成功！\n\n文件数: ${fileCount}\n代码块: ${chunkCount}\n\n现在可以搜索和提问了。`);

    // v4.2.6: Save to LocalStorage and update select
    addStoredProject(projectPath, fileCount);
    setSelectedProject(projectPath);
    renderProjectSelect();

    // Update result display
    render(result);
  } catch (err) {
    alert("❌ 索引失败:\n\n" + (err.message || err));
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = "+ Add";
  }
});

// ── v4.2.6: Delete Project button ────────────────────────────────────────────
document.getElementById("delete-project")?.addEventListener("click", async () => {
  const projectPath = projectRootInput.value?.trim();
  if (!projectPath) {
    alert("请先选择或输入项目路径");
    return;
  }

  if (!confirm(`确定要从列表中移除此项目吗？\n\n${projectPath}\n\n注意：这只会从下拉列表中移除，索引数据会保留在磁盘上。`)) {
    return;
  }

  removeStoredProject(projectPath);
  projectRootInput.value = '';
  setSelectedProject('');
  renderProjectSelect();
  alert("已从列表中移除");
});

// Ask Codebase (RAG)
function renderMarkdown(text) {
  // v4.6.1: extract ```mermaid blocks FIRST so the citation regex and
  // paragraph/br transforms below cannot mangle the diagram source.
  const mermaidBlocks = [];
  let html = text.replace(/```mermaid\n([\s\S]*?)```/g, (_, code) => {
    mermaidBlocks.push(code.trim());
    return `\nMERMAIDBLOCK${mermaidBlocks.length - 1}MERMAIDBLOCK\n`;
  });
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang}">${escapeHtml(code.trimEnd())}</code></pre>`);
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!<code[^>]*>)`([^`]+)`(?!<\/code>)/g, '<code>$1</code>');
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/([^>])\n([^<])/g, '$1<br>$2');
  // v4.2.4: Make [N] citations clickable
  // v4.6.0: also tolerate line-range suffixes the LLM sometimes emits, e.g. [1:L60-L88] / [2:60] —
  // previously only plain [N] matched and suffixed citations rendered as dead text.
  html = html.replace(/\[(\d+)(:L?\d+(?:\s*-\s*L?\d+)?)?\]/g, '<a href="#source-$1" class="qa-citation" data-source="$1">[$1$2]</a>');
  // v4.6.1: restore extracted mermaid blocks as renderable containers
  // (mermaid reads textContent, so escaped entities decode back to source)
  html = html.replace(/MERMAIDBLOCK(\d+)MERMAIDBLOCK/g, (_, idx) => {
    const code = mermaidBlocks[Number(idx)];
    return code === undefined ? '' : `<div class="qa-flow-diagram"><pre class="mermaid">${escapeHtml(code)}</pre></div>`;
  });
  return `<p>${html}</p>`.replace(/<p><\/p>/g, '');
}

// v4.6.1: Render ```mermaid blocks embedded in the QA answer as SVG diagrams.
// On failure the escaped source stays visible as a code block.
async function renderAnswerFlowDiagrams(containerEl) {
  try {
    if (!window.mermaid || !containerEl) return;
    const nodes = containerEl.querySelectorAll('.qa-flow-diagram pre.mermaid:not([data-processed])');
    if (nodes.length) {
      // Capture original Mermaid source before run() replaces textContent with svg
      const sources = Array.from(nodes).map((n) => n.textContent);
      await mermaid.run({ nodes });
      // v4.6.2: attach export toolbar to each rendered flow diagram
      const diagrams = containerEl.querySelectorAll('.qa-flow-diagram');
      diagrams.forEach((diagram, i) => {
        attachDiagramExport(diagram, () => sources[i] || '', `业务流程图-${i + 1}`);
      });
    }
  } catch (err) {
    console.warn('flow diagram render failed:', err);
  }
}

// ── v4.6.2: Mermaid diagram export (PNG / SVG / copy source) ──

function sanitizeFileName(name) {
  return (name || 'diagram').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

// Clone the rendered SVG and give it explicit pixel dimensions + namespaces so
// it can stand alone as a file and be rasterized to PNG. Mermaid emits a svg
// with a viewBox + style:max-width but no concrete width/height attributes.
function serializeSvg(svgEl) {
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const { width, height } = getSvgPixelSize(svgEl);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.style.maxWidth = '';
  return { xml: new XMLSerializer().serializeToString(clone), width, height };
}

function getSvgPixelSize(svgEl) {
  const viewBox = svgEl.viewBox && svgEl.viewBox.baseVal;
  if (viewBox && viewBox.width && viewBox.height) {
    return { width: Math.ceil(viewBox.width), height: Math.ceil(viewBox.height) };
  }
  try {
    const box = svgEl.getBBox();
    if (box.width && box.height) return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
  } catch { /* getBBox may throw if detached */ }
  const rect = svgEl.getBoundingClientRect();
  return { width: Math.ceil(rect.width) || 800, height: Math.ceil(rect.height) || 600 };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportDiagramSvg(svgEl, baseName) {
  const { xml } = serializeSvg(svgEl);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  downloadBlob(blob, `${sanitizeFileName(baseName)}.svg`);
}

function exportDiagramPng(svgEl, baseName) {
  const { xml, width, height } = serializeSvg(svgEl);
  const scale = 2; // retina-quality raster
  // data URL (encodeURIComponent handles UTF-8/CJK) loads more reliably into
  // an Image than a blob URL across browsers
  const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = new Image();
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) downloadBlob(pngBlob, `${sanitizeFileName(baseName)}.png`);
        else alert('PNG 导出失败，请改用 SVG 下载');
      }, 'image/png');
    } catch (err) {
      console.warn('PNG export failed:', err);
      alert('PNG 导出失败，请改用 SVG 下载');
    }
  };
  img.onerror = () => {
    console.warn('PNG export: image load failed');
    alert('PNG 导出失败，请改用 SVG 下载');
  };
  img.src = svgDataUrl;
}

async function copyTextToClipboard(text, btn) {
  const flash = (msg) => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = original; }, 1500);
  };
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    flash('已复制 ✓');
  } catch (err) {
    console.warn('copy failed:', err);
    flash('复制失败');
  }
}

// Inject a PNG/SVG/copy toolbar at the top of a rendered diagram container.
// getSource() returns the original Mermaid source for the copy action.
function attachDiagramExport(rootEl, getSource, baseName) {
  if (!rootEl || !rootEl.querySelector('svg')) return; // render failed — no toolbar
  // Replace any stale toolbar (call-chain container is reused across questions)
  const existing = rootEl.querySelector(':scope > .diagram-export-toolbar');
  if (existing) existing.remove();

  const toolbar = document.createElement('div');
  toolbar.className = 'diagram-export-toolbar';

  const makeBtn = (label, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'diagram-export-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  toolbar.appendChild(makeBtn('⬇ PNG', () => {
    const svg = rootEl.querySelector('svg');
    if (svg) exportDiagramPng(svg, baseName);
  }));
  toolbar.appendChild(makeBtn('⬇ SVG', () => {
    const svg = rootEl.querySelector('svg');
    if (svg) exportDiagramSvg(svg, baseName);
  }));
  toolbar.appendChild(makeBtn('⧉ 复制源码', (e) => {
    copyTextToClipboard(getSource() || '', e.currentTarget);
  }));

  rootEl.insertBefore(toolbar, rootEl.firstChild);
}

function renderSourceCard(source, maxScore, searchTerms = []) {
  const pct = maxScore > 0 ? Math.round((source.score / maxScore) * 100) : 0;
  const langClass = `lang-${source.language || 'unknown'}`;
  const snippet = source.snippet || '';
  const lines = snippet.split('\n');
  const totalLines = lines.length;

  // Find lines that contain search terms (for highlighting)
  const searchTermsLower = searchTerms.map(t => t.toLowerCase());
  const matchedLineIndices = new Set();
  lines.forEach((line, idx) => {
    const lineLower = line.toLowerCase();
    if (searchTermsLower.some(term => lineLower.includes(term))) {
      matchedLineIndices.add(idx);
    }
  });

  // Determine preview lines: show first 3 lines, or lines around matches
  let previewLines = [];
  let hasMore = false;

  if (matchedLineIndices.size > 0 && totalLines > 5) {
    // Show lines around first match with context
    const firstMatch = Math.min(...matchedLineIndices);
    const contextStart = Math.max(0, firstMatch - 1);
    const contextEnd = Math.min(totalLines, firstMatch + 3);
    previewLines = lines.slice(contextStart, contextEnd).map((line, i) => ({
      lineNum: source.startLine + contextStart + i,
      content: line,
      isMatch: matchedLineIndices.has(contextStart + i)
    }));
    hasMore = totalLines > (contextEnd - contextStart);
  } else if (totalLines > 5) {
    // No matches found, show first 3 lines
    previewLines = lines.slice(0, 3).map((line, i) => ({
      lineNum: source.startLine + i,
      content: line,
      isMatch: false
    }));
    hasMore = true;
  } else {
    // Show all lines if <= 5
    previewLines = lines.map((line, i) => ({
      lineNum: source.startLine + i,
      content: line,
      isMatch: matchedLineIndices.has(i)
    }));
    hasMore = false;
  }

  // v4.2.6: Apply syntax highlighting based on language
  const highlightLine = (line) => highlightSyntax(line, source.language, searchTermsLower);

  // Render preview with line numbers and highlights
  const previewHtml = previewLines.map(l =>
    `<div class="snippet-line${l.isMatch ? ' snippet-line-match' : ''}"><span class="snippet-linenum">${l.lineNum}</span>${highlightLine(l.content)}</div>`
  ).join('');

  // Render full snippet for expansion
  const fullHtml = lines.map((line, i) =>
    `<div class="snippet-line${matchedLineIndices.has(i) ? ' snippet-line-match' : ''}"><span class="snippet-linenum">${source.startLine + i}</span>${highlightLine(line)}</div>`
  ).join('');

  const snippetId = `snippet-${source.index}`;
  // v4.2.9: Default collapsed for better performance with many results
  const expandBtn = `<button class="snippet-expand-btn" onclick="toggleSnippet('${snippetId}')" title="展开/折叠代码">📄 查看代码 (${totalLines} 行)</button>`;

  return `
    <div id="source-${source.index}" class="qa-source-card">
      <div class="qa-source-index">${source.index}</div>
      <div class="qa-source-info">
        <div class="qa-source-path">${escapeHtml(source.filePath)}</div>
        <div class="qa-source-meta">
          <span class="qa-source-badge ${langClass}">${escapeHtml(source.language || '?')}</span>
          L${source.startLine}-${source.endLine} (${totalLines} lines)
          ${matchedLineIndices.size > 0 ? `<span class="qa-source-matches">${matchedLineIndices.size} match${matchedLineIndices.size > 1 ? 'es' : ''}</span>` : ''}
        </div>
        ${renderSourceBundleSelector(source, `qa-${source.index}`)}
        ${renderSearchResultActions(source)}
        ${renderLazyContextAction(source)}
        ${renderSearchMatchExplanation(source)}
        <div class="qa-source-snippet-container" id="${snippetId}">
          <div class="qa-source-snippet-preview" hidden>${previewHtml}</div>
          <div class="qa-source-snippet-full" hidden>${fullHtml}</div>
          ${expandBtn}
        </div>
      </div>
      <div class="qa-source-score">
        <div class="qa-source-score-bar"><div class="qa-source-score-fill" style="width:${pct}%"></div></div>
        <div class="qa-source-score-label">${source.score?.toFixed(2) ?? '-'}</div>
      </div>
    </div>`;
}

function toggleSnippet(id) {
  const container = document.getElementById(id);
  if (!container) return;
  const preview = container.querySelector('.qa-source-snippet-preview');
  const full = container.querySelector('.qa-source-snippet-full');
  const btn = container.querySelector('.snippet-expand-btn');

  // v4.2.9: Support default-collapsed mode (both preview and full are hidden initially)
  const isCollapsed = preview.hidden && full.hidden;
  const isShowingFull = !full.hidden;

  if (isCollapsed) {
    // First click: show preview
    preview.hidden = false;
    btn.textContent = '📖 展开全部';
    btn.classList.add('expanded');
  } else if (!isShowingFull) {
    // Second click: show full
    preview.hidden = true;
    full.hidden = false;
    btn.textContent = '📕 收起代码';
  } else {
    // Third click: collapse all
    preview.hidden = true;
    full.hidden = true;
    btn.textContent = btn.dataset.originalText || `📄 查看代码`;
    btn.classList.remove('expanded');
  }
}

// Store original button text when page loads
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.snippet-expand-btn').forEach(btn => {
    btn.dataset.originalText = btn.textContent;
  });
});

function setStep(stepsEl, phase, icon, text, done) {
  let el = stepsEl.querySelector(`[data-phase="${phase}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'qa-step';
    el.dataset.phase = phase;
    el.innerHTML = `<div class="qa-step-icon"></div><div class="qa-step-text"></div>`;
    stepsEl.appendChild(el);
  }
  const iconEl = el.querySelector('.qa-step-icon');
  iconEl.textContent = done ? '✅' : icon;
  iconEl.className = `qa-step-icon${done ? '' : ' spinning'}`;
  el.querySelector('.qa-step-text').textContent = text;
}

let qaTimerInterval = null;
let currentAbortController = null; // v4.2.8: Track abort controller for Stop button
// v4.2.5: Multi-turn conversation with LocalStorage persistence
const QA_HISTORY_KEY = 'ace-mcp-qa-history';
let qaConversationHistory = JSON.parse(localStorage.getItem(QA_HISTORY_KEY) || '[]');

// v4.2.9: Session token usage tracking
const SESSION_TOKENS_KEY = 'ace-mcp-session-tokens';
let sessionTokenUsage = JSON.parse(localStorage.getItem(SESSION_TOKENS_KEY) || '{"promptTokens":0,"completionTokens":0,"questionCount":0}');

function updateSessionTokens(promptTokens, completionTokens) {
  sessionTokenUsage.promptTokens += promptTokens || 0;
  sessionTokenUsage.completionTokens += completionTokens || 0;
  sessionTokenUsage.questionCount += 1;
  localStorage.setItem(SESSION_TOKENS_KEY, JSON.stringify(sessionTokenUsage));
  renderSessionTokenStats();
}

function resetSessionTokens() {
  sessionTokenUsage = { promptTokens: 0, completionTokens: 0, questionCount: 0 };
  localStorage.setItem(SESSION_TOKENS_KEY, JSON.stringify(sessionTokenUsage));
  renderSessionTokenStats();
}

function renderSessionTokenStats() {
  const el = document.getElementById('session-token-stats');
  if (!el) return;
  const total = sessionTokenUsage.promptTokens + sessionTokenUsage.completionTokens;
  el.innerHTML = `累计: ${sessionTokenUsage.questionCount} 次提问 | ${total.toLocaleString()} tokens (输入 ${sessionTokenUsage.promptTokens.toLocaleString()} + 输出 ${sessionTokenUsage.completionTokens.toLocaleString()})`;
  el.hidden = sessionTokenUsage.questionCount === 0;
}

// v4.2.9: Error classification helper
function classifyError(error) {
  const msg = (error?.message || String(error)).toLowerCase();
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('failed to fetch') || msg.includes('连接')) {
    return { type: 'network', icon: '🌐', label: '网络错误', hint: '请检查网络连接，或确认服务是否正在运行' };
  }
  if (msg.includes('timeout') || msg.includes('超时') || msg.includes('abort')) {
    return { type: 'timeout', icon: '⏱️', label: '请求超时', hint: '可以尝试增加超时时间，或简化问题' };
  }
  if (msg.includes('llm') || msg.includes('api') || msg.includes('model') || msg.includes('token') || msg.includes('rate')) {
    return { type: 'llm', icon: '🤖', label: 'LLM 服务错误', hint: '请检查 LLM API 配置是否正确，或稍后重试' };
  }
  if (msg.includes('index') || msg.includes('project') || msg.includes('not found') || msg.includes('不存在')) {
    return { type: 'index', icon: '📂', label: '索引错误', hint: '请确认项目路径正确，并尝试重新索引项目' };
  }
  return { type: 'unknown', icon: '❌', label: '未知错误', hint: '请查看详细错误信息' };
}

function saveQaHistory() {
  // Keep only last 12 messages (6 turns)
  if (qaConversationHistory.length > 12) {
    qaConversationHistory = qaConversationHistory.slice(-12);
  }
  localStorage.setItem(QA_HISTORY_KEY, JSON.stringify(qaConversationHistory));
}

function clearQaHistory() {
  qaConversationHistory = [];
  localStorage.removeItem(QA_HISTORY_KEY);
}

// ── Ask Codebase (SSE Streaming by default since v4.2.7) ─────────────────────
// v4.2.8: Refactored to support Stop button and Enter key
// v4.2.8: Use fetch + ReadableStream instead of EventSource for POST support
async function runAskQuestion() {
  const askBtn = document.getElementById("run-ask");
  const stopBtn = document.getElementById("qa-stop");
  const progressEl = document.getElementById("qa-progress");
  const loadingEl = document.getElementById("qa-loading");
  const timerEl = document.getElementById("qa-timer");
  const stepsEl = document.getElementById("qa-steps");
  const answerBodyEl = document.getElementById("qa-answer-body");
  const sourcesListEl = document.getElementById("qa-sources-list");
  const statsEl = document.getElementById("qa-stats");
  const errorEl = document.getElementById("qa-error");
  const rawEl = document.getElementById("qa-raw");
  const question = document.getElementById("qa-question")?.value?.trim();
  if (!question) return;

  const timeoutSec = Number(qaTimeoutInput?.value || 120);
  const projectRoot = projectRootInput.value;
  const maxSources = Number(qaMaxSourcesInput?.value || QA_MAX_SOURCES_DEFAULT);
  const maxContextTokens = Number(qaMaxContextTokensInput?.value || QA_CONTEXT_TOKENS_DEFAULT);
  const maxTokens = Number(qaMaxTokensInput?.value || 8192);
  const retries = Number(qaRetriesInput?.value || 2);
  const includeSummary = document.getElementById("qa-include-summary")?.checked ?? true;
  const localCode = document.getElementById("qa-local-code")?.checked ?? true;
  const contextMode = localCode ? "full-file" : "chunk";

  // Reset UI
  askBtn.disabled = true;
  askBtn.textContent = '生成中...';
  if (stopBtn) stopBtn.hidden = false;
  [answerBodyEl, sourcesListEl, statsEl, errorEl].forEach(el => { if (el) { el.hidden = true; el.innerHTML = ''; } });
  renderQaEffectiveParams(null);
  // v4.3.5: Also reset call chain diagram and related questions
  const callchainEl = document.getElementById('qa-callchain-diagram');
  if (callchainEl) { callchainEl.hidden = true; }
  const relatedEl = document.getElementById('qa-related-questions');
  if (relatedEl) { relatedEl.hidden = true; }
  rawEl.innerHTML = '';
  stepsEl.innerHTML = '';
  progressEl.hidden = false;
  loadingEl.hidden = false;

  const startTime = Date.now();
  if (qaTimerInterval) clearInterval(qaTimerInterval);
  qaTimerInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    timerEl.textContent = `${elapsed}s / ${timeoutSec}s`;
  }, 100);

  let fullAnswer = '';
  let fullThinking = ''; // v4.2.8: Track DeepSeek thinking content
  let finalData = null;
  let wasStopped = false;
  const searchTerms = question.split(/\s+/).filter(t => t.length > 2);

  // Create AbortController for stop button
  const abortController = new AbortController();
  currentAbortController = abortController;

  try {
    // Use fetch with POST to avoid URL length limits
    const response = await fetch('/api/qa/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectRootPath: projectRoot,
        question,
        maxSources,
        maxContextTokens,
        includeSummary,
        contextMode,
        maxTokens,
        timeoutSeconds: timeoutSec,
        retries,
        history: qaConversationHistory,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`服务器错误 ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('无法读取响应流');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));

          switch (data.type) {
            case 'phase':
              if (data.status === 'start') {
                const icons = { index: '📂', search: '🔍', callchain: '🔗', summary: '📋', llm: '🤖' };
                const labels = {
                  index: '检查项目索引...',
                  search: '搜索相关代码...',
                  callchain: '分析调用链...',
                  summary: '加载项目摘要...',
                  llm: '生成回答中...',
                };
                setStep(stepsEl, data.phase, icons[data.phase] || '⏳', labels[data.phase] || data.phase, false);
              } else if (data.status === 'done') {
                const icons = { index: '📂', search: '🔍', callchain: '🔗', summary: '📋', llm: '🤖' };
                let text = `${data.phase} 完成`;
                if (data.ms) text += ` (${data.ms}ms)`;
                if (data.resultCount !== undefined) text = `找到 ${data.resultCount} 个代码片段 (${data.ms}ms)`;
                if (data.chainCount !== undefined) text = data.chainCount > 0 ? `发现 ${data.chainCount} 个调用链 (${data.ms}ms)` : '未发现调用链';
                if (data.hadSummary !== undefined) text = data.hadSummary ? '摘要已加载' : '无项目摘要';
                setStep(stepsEl, data.phase, icons[data.phase] || '✅', text, true);
              }
              break;

            case 'sources':
              if (data.sources?.length) {
                const maxScore = Math.max(...data.sources.map(s => s.score || 0));
                const cards = data.sources.map(s => renderSourceCard(s, maxScore, searchTerms)).join('');
                sourcesListEl.innerHTML = `<h4>参考代码 (${data.sources.length})</h4>${renderContextBundleToolbar("qa")}` + cards;
                bindSearchResultActions();
                bindSearchIdeActions();
                bindContextBundleActions();
                bindLazyContextActions();
                sourcesListEl.hidden = false;
              }
              break;

            case 'token':
              if (data.content) {
                if (data.isThinking) {
                  // v4.2.10: Show thinking as inline gray text while waiting for answer
                  fullThinking += data.content;
                  // Only show thinking if no answer yet
                  if (!fullAnswer) {
                    answerBodyEl.innerHTML = `<div class="qa-thinking-inline">💭 ${escapeHtml(fullThinking)}</div>`;
                  }
                } else {
                  // Regular answer content - replace thinking with answer
                  fullAnswer += data.content;
                  // Show answer with thinking collapsed below
                  const thinkingHtml = fullThinking
                    ? `<details class="qa-thinking-collapsed">
                        <summary>💭 查看思考过程</summary>
                        <div class="qa-thinking-content">${escapeHtml(fullThinking)}</div>
                      </details>`
                    : '';
                  answerBodyEl.innerHTML = renderMarkdown(fullAnswer) + thinkingHtml;
                }
                answerBodyEl.hidden = false;
              }
              break;

            case 'done':
              finalData = data;
              renderQaEffectiveParams(finalData?.request);
              // v4.3.2: Show related questions
              setupRelatedQuestions(data.relatedQuestions);
              // v4.3.5: Render call chain diagram
              renderCallChainDiagram(data.callChains);
              // v4.6.1: Render answer-embedded mermaid flow diagrams (only safe
              // after streaming ends — each token rewrites innerHTML)
              renderAnswerFlowDiagrams(answerBodyEl);
              break;

            case 'error':
              throw new Error(data.error);
          }
        } catch (parseErr) {
          if (parseErr.message && !parseErr.message.includes('JSON')) {
            throw parseErr; // Re-throw non-JSON errors
          }
          console.warn('SSE parse warning:', parseErr, trimmed);
        }
      }
    }

    // Success - save conversation history (even if stopped, save partial answer)
    if (fullAnswer) {
      qaConversationHistory.push(
        { role: 'user', content: question },
        { role: 'assistant', content: fullAnswer + (wasStopped ? '\n\n[回答已中断]' : '') }
      );
      saveQaHistory();

      // Show feedback (only if not stopped)
      if (!wasStopped) {
        const feedbackEl = document.getElementById('qa-feedback');
        feedbackEl.hidden = false;
        feedbackEl.dataset.context = JSON.stringify({
          projectRootPath: projectRoot,
          question,
          answer: fullAnswer,
          usage: finalData?.usage,
          timing: finalData?.timing,
        });
        document.getElementById('qa-feedback-positive').classList.remove('selected');
        document.getElementById('qa-feedback-negative').classList.remove('selected');
        document.getElementById('qa-correction-form').hidden = true;
        document.getElementById('qa-feedback-thanks').hidden = true;
        document.getElementById('qa-feedback-positive').disabled = false;
        document.getElementById('qa-feedback-negative').disabled = false;
      }
    }

    // Stats
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const statItems = [`<span class="qa-stat"><span class="qa-stat-label">总计:</span> ${elapsed}s</span>`];
    if (finalData?.timing?.indexMs) statItems.push(`<span class="qa-stat"><span class="qa-stat-label">索引:</span> ${finalData.timing.indexMs}ms</span>`);
    if (finalData?.timing?.searchMs) statItems.push(`<span class="qa-stat"><span class="qa-stat-label">搜索:</span> ${finalData.timing.searchMs}ms</span>`);
    if (finalData?.timing?.llmMs) statItems.push(`<span class="qa-stat"><span class="qa-stat-label">LLM:</span> ${finalData.timing.llmMs}ms</span>`);
    if (finalData?.usage) {
      statItems.push(`<span class="qa-stat"><span class="qa-stat-label">输入:</span> ${finalData.usage.promptTokens} tok</span>`);
      statItems.push(`<span class="qa-stat"><span class="qa-stat-label">输出:</span> ${finalData.usage.completionTokens} tok</span>`);
      // v4.2.9: Update session token stats
      updateSessionTokens(finalData.usage.promptTokens, finalData.usage.completionTokens);
    }
    if (wasStopped) statItems.push(`<span class="qa-stat" style="color:#dc2626"><span class="qa-stat-label">状态:</span> 已中断</span>`);
    statsEl.innerHTML = statItems.join('');
    statsEl.hidden = false;

    if (finalData) {
      rawEl.innerHTML = `<details><summary>查看原始 JSON</summary><pre>${escapeHtml(JSON.stringify(finalData, null, 2))}</pre></details>`;
    }

  } catch (error) {
    if (error.name === 'AbortError') {
      wasStopped = true;
      // User stopped, show partial answer
      if (fullAnswer) {
        answerBodyEl.innerHTML += '<p style="color:#dc2626;font-style:italic;margin-top:12px">⏹️ 回答已中断</p>';
      }
    } else {
      // v4.2.9: Classify and display error with helpful hints
      const errInfo = classifyError(error);
      errorEl.innerHTML = `
        <div class="qa-error-card">
          <div class="qa-error-header">
            <span class="qa-error-icon">${errInfo.icon}</span>
            <span class="qa-error-label">${errInfo.label}</span>
          </div>
          <div class="qa-error-message">${escapeHtml(error.message || String(error))}</div>
          <div class="qa-error-hint">💡 ${errInfo.hint}</div>
        </div>`;
      errorEl.hidden = false;
    }
  } finally {
    clearInterval(qaTimerInterval);
    qaTimerInterval = null;
    loadingEl.hidden = true;
    askBtn.disabled = false;
    askBtn.textContent = '发送';
    if (stopBtn) stopBtn.hidden = true;
    currentAbortController = null;
  }
}

document.getElementById("run-ask")?.addEventListener("click", runAskQuestion);

// v4.2.8: Stop button handler
document.getElementById("qa-stop")?.addEventListener("click", () => {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  const stopBtn = document.getElementById("qa-stop");
  if (stopBtn) stopBtn.hidden = true;
});

// v4.2.8: Enter key to submit (Shift+Enter for newline)
document.getElementById("qa-question")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const askBtn = document.getElementById("run-ask");
    if (askBtn && !askBtn.disabled) {
      runAskQuestion();
    }
  }
});

// ── QA Feedback handlers ─────────────────────────────────────────────────────
document.getElementById('qa-feedback-positive')?.addEventListener('click', async function() {
  const feedbackEl = document.getElementById('qa-feedback');
  const context = JSON.parse(feedbackEl.dataset.context || '{}');
  if (!context.question) return;

  this.classList.add('selected');
  document.getElementById('qa-feedback-negative').classList.remove('selected');
  this.disabled = true;
  document.getElementById('qa-feedback-negative').disabled = true;

  try {
    await request('POST', '/api/qa/feedback', {
      ...context,
      rating: 'positive',
    });
    document.getElementById('qa-feedback-thanks').hidden = false;
  } catch (error) {
    console.error('Feedback submission failed:', error);
  }
});

document.getElementById('qa-feedback-negative')?.addEventListener('click', function() {
  this.classList.add('selected');
  document.getElementById('qa-feedback-positive').classList.remove('selected');
  document.getElementById('qa-correction-form').hidden = false;
});

document.getElementById('qa-submit-correction')?.addEventListener('click', async function() {
  const feedbackEl = document.getElementById('qa-feedback');
  const context = JSON.parse(feedbackEl.dataset.context || '{}');
  if (!context.question) return;

  const correction = document.getElementById('qa-correction').value.trim();

  this.disabled = true;
  document.getElementById('qa-feedback-positive').disabled = true;
  document.getElementById('qa-feedback-negative').disabled = true;

  try {
    await request('POST', '/api/qa/feedback', {
      ...context,
      rating: 'negative',
      correction: correction || undefined,
    });
    document.getElementById('qa-correction-form').hidden = true;
    document.getElementById('qa-feedback-thanks').hidden = false;
  } catch (error) {
    console.error('Feedback submission failed:', error);
    this.disabled = false;
  }
});

// ── v4.2.5: New conversation button with LocalStorage clear ─────────────────
document.getElementById('qa-new-conversation')?.addEventListener('click', function() {
  clearQaHistory();
  document.getElementById('qa-question').value = '';
  document.getElementById('qa-answer-body').hidden = true;
  document.getElementById('qa-answer-body').innerHTML = '';
  document.getElementById('qa-sources-list').hidden = true;
  document.getElementById('qa-sources-list').innerHTML = '';
  document.getElementById('qa-stats').hidden = true;
  renderQaEffectiveParams(null);
  document.getElementById('qa-feedback').hidden = true;
  document.getElementById('qa-error').hidden = true;
  document.getElementById('qa-raw').innerHTML = '';
  document.getElementById('qa-progress').hidden = true;
  document.getElementById('qa-steps').innerHTML = '';
});

// ── v4.2.4: Citation click handler for scrolling to sources ──────────────────
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('qa-citation')) {
    e.preventDefault();
    const sourceNum = e.target.dataset.source;
    const sourceCard = document.getElementById(`source-${sourceNum}`);
    if (sourceCard) {
      sourceCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Add highlight effect
      sourceCard.classList.add('highlight');
      setTimeout(() => sourceCard.classList.remove('highlight'), 2000);
    }
  }
});

// v4.2.8: Enter key to submit search (Shift+Enter for newline)
document.getElementById("search-query")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("run-search")?.click();
  }
});

// v4.2.9: Initialize session token stats on page load
renderSessionTokenStats();

// v4.2.9: Reset session tokens button
document.getElementById('reset-session-tokens')?.addEventListener('click', () => {
  if (confirm('确定要重置本次会话的 Token 统计吗？')) {
    resetSessionTokens();
  }
});

// v4.3.2: Related questions click handler
function setupRelatedQuestions(questions) {
  const container = document.getElementById('qa-related-questions');
  if (!container || !questions || questions.length === 0) {
    if (container) container.hidden = true;
    return;
  }

  container.innerHTML = `
    <div class="qa-related-header">相关问题</div>
    <div class="qa-related-list">
      ${questions.map(q => `<button class="qa-related-btn" type="button">${escapeHtml(q)}</button>`).join('')}
    </div>
  `;
  container.hidden = false;

  // Add click handlers
  container.querySelectorAll('.qa-related-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const questionInput = document.getElementById('qa-question');
      if (questionInput) {
        questionInput.value = btn.textContent;
        questionInput.focus();
        // Optionally auto-submit
        // runAskQuestion();
      }
    });
  });
}

// v4.3.5: Call chain diagram rendering
function renderCallChainDiagram(chains) {
  const container = document.getElementById('qa-callchain-diagram');
  if (!container) return;

  // Hide if no chains
  if (!chains || chains.length === 0) {
    container.hidden = true;
    return;
  }

  // Generate Mermaid flowchart syntax
  const nodeIds = new Map(); // symbol -> safe id
  let nodeCounter = 0;

  function getSafeId(symbol) {
    if (!nodeIds.has(symbol)) {
      nodeIds.set(symbol, `n${nodeCounter++}`);
    }
    return nodeIds.get(symbol);
  }

  function escapeLabel(label) {
    // Escape special Mermaid characters
    return label.replace(/["\\]/g, '').replace(/[<>]/g, '');
  }

  let mermaidCode = 'flowchart LR\n';
  const edges = new Set(); // Avoid duplicate edges

  for (const chain of chains) {
    const targetId = getSafeId(chain.symbol);
    const targetLabel = escapeLabel(chain.symbol);
    mermaidCode += `  ${targetId}["${targetLabel}"]\n`;

    // Style the main symbol node
    mermaidCode += `  style ${targetId} fill:#dbeafe,stroke:#2563eb\n`;

    // Add callers (who calls this symbol)
    for (const caller of chain.callers) {
      const callerId = getSafeId(caller.symbol);
      const callerLabel = escapeLabel(caller.symbol);
      const edgeKey = `${callerId}->${targetId}`;
      if (!edges.has(edgeKey)) {
        edges.add(edgeKey);
        mermaidCode += `  ${callerId}["${callerLabel}"] --> ${targetId}\n`;
      }
    }

    // Add callees (what this symbol calls)
    for (const callee of chain.callees) {
      const calleeId = getSafeId(callee.symbol);
      const calleeLabel = escapeLabel(callee.symbol);
      const edgeKey = `${targetId}->${calleeId}`;
      if (!edges.has(edgeKey)) {
        edges.add(edgeKey);
        mermaidCode += `  ${targetId} --> ${calleeId}["${calleeLabel}"]\n`;
      }
    }
  }

  // Render the diagram
  const mermaidEl = container.querySelector('.mermaid');
  if (mermaidEl) {
    mermaidEl.textContent = mermaidCode;
    container.hidden = false;
    container.classList.remove('collapsed');

    // Use mermaid.run() for rendering
    if (typeof mermaid !== 'undefined') {
      try {
        // v4.6.2: attach export toolbar once the svg is rendered
        const contentEl = mermaidEl.parentElement;
        Promise.resolve(mermaid.run({ nodes: [mermaidEl] }))
          .then(() => attachDiagramExport(contentEl, () => mermaidCode, '调用链关系'))
          .catch((err) => console.warn('Mermaid render error:', err));
      } catch (err) {
        console.warn('Mermaid render error:', err);
        mermaidEl.innerHTML = `<pre style="color:#666;font-size:12px;">${escapeHtml(mermaidCode)}</pre>`;
      }
    }
  }
}

// v4.3.5: Call chain toggle button
document.getElementById('qa-callchain-toggle')?.addEventListener('click', function() {
  const container = document.getElementById('qa-callchain-diagram');
  if (container) {
    const isCollapsed = container.classList.toggle('collapsed');
    this.textContent = isCollapsed ? '展开' : '收起';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v4.4.2: Quality Evaluation Panel
// ─────────────────────────────────────────────────────────────────────────────
const qualityTestCases = [];

function renderQualityCaseList() {
  const container = document.getElementById('quality-case-list');
  if (!container) return;

  if (qualityTestCases.length === 0) {
    container.innerHTML = '<p class="hint">暂无测试用例，请添加</p>';
    return;
  }

  container.innerHTML = qualityTestCases.map((tc, i) => `
    <div class="quality-case-item" data-index="${i}">
      <span class="case-query">${escapeHtml(tc.query)}</span>
      <span class="case-expected">${escapeHtml(tc.expectedFiles.join(', '))}</span>
      <button class="case-remove" type="button" title="删除">✕</button>
    </div>
  `).join('');

  // Bind remove handlers
  container.querySelectorAll('.case-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.closest('.quality-case-item').dataset.index);
      qualityTestCases.splice(idx, 1);
      renderQualityCaseList();
    });
  });
}

// Add test case
document.getElementById('quality-add-case')?.addEventListener('click', () => {
  const queryInput = document.getElementById('quality-test-query');
  const expectedInput = document.getElementById('quality-test-expected');
  const query = queryInput?.value?.trim();
  const expected = expectedInput?.value?.trim();

  if (!query || !expected) {
    alert('请输入查询和期望文件路径');
    return;
  }

  qualityTestCases.push({
    query,
    expectedFiles: expected.split(',').map(f => f.trim()).filter(Boolean),
  });

  queryInput.value = '';
  expectedInput.value = '';
  renderQualityCaseList();
});

// Run evaluation
document.getElementById('quality-run-eval')?.addEventListener('click', async () => {
  if (qualityTestCases.length === 0) {
    alert('请先添加测试用例');
    return;
  }

  const projectRootPath = document.getElementById('project-root')?.value?.trim();
  if (!projectRootPath) {
    alert('请先选择项目');
    return;
  }

  const resultsContainer = document.getElementById('quality-results');
  const caseResultsContainer = document.getElementById('quality-case-results');

  try {
    const response = await fetch('/api/evaluate-search-quality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectRootPath,
        cases: qualityTestCases.map(tc => ({
          query: tc.query,
          expectedFiles: tc.expectedFiles,
        })),
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Evaluation failed');
    }

    const result = await response.json();

    // Update metrics
    document.getElementById('quality-pass-rate').textContent = `${(result.metrics.passRate * 100).toFixed(1)}%`;
    document.getElementById('quality-top1-recall').textContent = `${(result.metrics.top1Recall * 100).toFixed(1)}%`;
    document.getElementById('quality-top5-recall').textContent = `${(result.metrics.top5Recall * 100).toFixed(1)}%`;
    document.getElementById('quality-mrr').textContent = result.metrics.meanReciprocalRank.toFixed(3);

    // Render case results
    caseResultsContainer.innerHTML = result.caseResults.map((cr, i) => {
      const statusClass = cr.passed ? 'passed' : 'failed';
      const rankText = cr.bestRank > 0 ? `排名 #${cr.bestRank}` : '未命中';
      const foundFiles = cr.foundAt.slice(0, 3).map(f => `${f.filePath} (#${f.rank})`).join(', ');
      return `
        <div class="quality-case-result ${statusClass}" data-index="${i}">
          <div class="result-query">${escapeHtml(cr.query)}</div>
          <div class="result-rank">${cr.passed ? '✓' : '✗'} ${rankText} | 耗时 ${cr.searchMs}ms</div>
          ${foundFiles ? `<div class="result-files">命中: ${escapeHtml(foundFiles)}</div>` : ''}
        </div>
      `;
    }).join('');

    resultsContainer.hidden = false;

  } catch (err) {
    alert('评估失败: ' + err.message);
  }
});

// Save cases to localStorage
document.getElementById('quality-save-cases')?.addEventListener('click', () => {
  if (qualityTestCases.length === 0) {
    alert('没有测试用例可保存');
    return;
  }
  const projectRootPath = document.getElementById('project-root')?.value?.trim() || 'default';
  const key = `ace-mcp-quality-cases-${projectRootPath.replace(/\//g, '_')}`;
  localStorage.setItem(key, JSON.stringify(qualityTestCases));
  alert(`已保存 ${qualityTestCases.length} 个测试用例`);
});

// Load cases from localStorage
document.getElementById('quality-load-cases')?.addEventListener('click', () => {
  const projectRootPath = document.getElementById('project-root')?.value?.trim() || 'default';
  const key = `ace-mcp-quality-cases-${projectRootPath.replace(/\//g, '_')}`;
  const saved = localStorage.getItem(key);
  if (!saved) {
    alert('未找到保存的测试用例');
    return;
  }
  try {
    const loaded = JSON.parse(saved);
    qualityTestCases.length = 0;
    qualityTestCases.push(...loaded);
    renderQualityCaseList();
    alert(`已加载 ${qualityTestCases.length} 个测试用例`);
  } catch {
    alert('加载失败');
  }
});

// Clear cases
document.getElementById('quality-clear-cases')?.addEventListener('click', () => {
  if (qualityTestCases.length === 0) return;
  if (!confirm('确定清空所有测试用例？')) return;
  qualityTestCases.length = 0;
  renderQualityCaseList();
  document.getElementById('quality-results').hidden = true;
});

// Initialize
renderQualityCaseList();
