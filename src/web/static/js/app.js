const MAX_HISTORY = 20;

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

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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
      throw new Error(JSON.stringify(data, null, 2));
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(timeoutMs/1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseSearchLanguages(value) {
  const allowed = new Set(["java", "javascript", "dotnet", "python", "markdown"]);
  return [...new Set(value.split(",").map(item => item.trim().toLowerCase()).filter(item => allowed.has(item)))];
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

  if (cards.length === 0) {
    resultSummaryEl.hidden = true;
    resultSummaryEl.innerHTML = "";
    return;
  }

  resultSummaryEl.hidden = false;
  resultSummaryEl.innerHTML = cards.map(card =>
    `<div class="result-summary-card"><strong>${escapeHtml(card.label)}</strong><span>${escapeHtml(card.value)}</span></div>`
  ).join("");
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

document.getElementById("load-health")?.addEventListener("click", () => run(() => request("GET", "/health")));
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
      const result = await request("POST", "/api/index-project", {
        mode: "incremental",
        projectRootPath: projectPath
      });

      // Update file count if available
      const fileCount = result?.stats?.project?.indexedFileCount || result?.data?.indexedFiles;
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

// v4.2.8: Auto-preload index on page load if a project is selected
(async function preloadOnStartup() {
  const selectedProject = getSelectedProject();
  if (selectedProject && projectRootInput) {
    console.log('Auto-preloading index for:', selectedProject);
    try {
      await request("POST", "/api/index-project", {
        mode: "incremental",
        projectRootPath: selectedProject
      });
      console.log('Index preloaded successfully');
    } catch (err) {
      console.warn('Failed to preload index on startup:', err);
    }
  }
})();

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
document.getElementById("run-generate-summary")?.addEventListener("click", () => run(() => request("POST", "/api/summary/generate", {
  projectRootPath: projectRootInput.value
})));
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
    const result = await request("POST", "/api/index-project", {
      projectRootPath: projectPath,
      mode: "full"
    });

    // Show success message
    const fileCount = result?.data?.indexedFiles ?? result?.stats?.indexSync?.indexedFiles ?? 0;
    const chunkCount = result?.data?.chunkCount ?? result?.stats?.indexSync?.chunkCount ?? 0;
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
  let html = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
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
  html = html.replace(/\[(\d+)\]/g, '<a href="#source-$1" class="qa-citation" data-source="$1">[$1]</a>');
  return `<p>${html}</p>`.replace(/<p><\/p>/g, '');
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

  const timeoutSec = Number(document.getElementById("qa-timeout")?.value || 120);
  const projectRoot = projectRootInput.value;
  const maxSources = Number(document.getElementById("qa-max-sources")?.value || 10);
  const includeSummary = document.getElementById("qa-include-summary")?.checked ?? true;

  // Reset UI
  askBtn.disabled = true;
  askBtn.textContent = '生成中...';
  if (stopBtn) stopBtn.hidden = false;
  [answerBodyEl, sourcesListEl, statsEl, errorEl].forEach(el => { if (el) { el.hidden = true; el.innerHTML = ''; } });
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
        includeSummary,
        timeoutSeconds: timeoutSec,
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
                const icons = { index: '📂', search: '🔍', summary: '📋', llm: '🤖' };
                const labels = {
                  index: '检查项目索引...',
                  search: '搜索相关代码...',
                  summary: '加载项目摘要...',
                  llm: '生成回答中...',
                };
                setStep(stepsEl, data.phase, icons[data.phase] || '⏳', labels[data.phase] || data.phase, false);
              } else if (data.status === 'done') {
                const icons = { index: '📂', search: '🔍', summary: '📋', llm: '🤖' };
                let text = `${data.phase} 完成`;
                if (data.ms) text += ` (${data.ms}ms)`;
                if (data.resultCount !== undefined) text = `找到 ${data.resultCount} 个代码片段 (${data.ms}ms)`;
                if (data.hadSummary !== undefined) text = data.hadSummary ? '摘要已加载' : '无项目摘要';
                setStep(stepsEl, data.phase, icons[data.phase] || '✅', text, true);
              }
              break;

            case 'sources':
              if (data.sources?.length) {
                const maxScore = Math.max(...data.sources.map(s => s.score || 0));
                const cards = data.sources.map(s => renderSourceCard(s, maxScore, searchTerms)).join('');
                sourcesListEl.innerHTML = `<h4>参考代码 (${data.sources.length})</h4>` + cards;
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
