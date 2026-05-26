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
      autostartBadge.textContent = data.enabled ? (data.running ? "Running" : "Enabled") : "Disabled";
      autostartBadge.className = "autostart-badge " + (data.enabled ? (data.running ? "running" : "enabled") : "disabled");
    }
    if (autostartPlatform) {
      autostartPlatform.textContent = data.platform + (data.webPort ? ` (port ${data.webPort})` : "");
    }
  } catch (err) {
    if (autostartBadge) {
      autostartBadge.textContent = "Error";
      autostartBadge.className = "autostart-badge disabled";
    }
  }
}

document.getElementById("autostart-enable")?.addEventListener("click", async () => {
  try {
    await request("POST", "/api/autostart", { action: "enable" });
    alert("Autostart enabled! Service will start on next system boot.");
    loadAutostartStatus();
  } catch (err) {
    alert("Failed to enable autostart: " + (err.message || err));
  }
});

document.getElementById("autostart-disable")?.addEventListener("click", async () => {
  try {
    await request("POST", "/api/autostart", { action: "disable" });
    alert("Autostart disabled.");
    loadAutostartStatus();
  } catch (err) {
    alert("Failed to disable autostart: " + (err.message || err));
  }
});

// Load autostart status on page load
loadAutostartStatus();

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

  // Render preview with line numbers and highlights
  const previewHtml = previewLines.map(l =>
    `<div class="snippet-line${l.isMatch ? ' snippet-line-match' : ''}"><span class="snippet-linenum">${l.lineNum}</span>${escapeHtml(l.content)}</div>`
  ).join('');

  // Render full snippet for expansion
  const fullHtml = lines.map((line, i) =>
    `<div class="snippet-line${matchedLineIndices.has(i) ? ' snippet-line-match' : ''}"><span class="snippet-linenum">${source.startLine + i}</span>${escapeHtml(line)}</div>`
  ).join('');

  const snippetId = `snippet-${source.index}`;
  const expandBtn = hasMore ? `<button class="snippet-expand-btn" onclick="toggleSnippet('${snippetId}')" title="Expand/Collapse">+${totalLines - previewLines.length} more lines</button>` : '';

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
          <div class="qa-source-snippet-preview">${previewHtml}</div>
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

  if (full.hidden) {
    preview.hidden = true;
    full.hidden = false;
    btn.textContent = 'Collapse';
    btn.classList.add('expanded');
  } else {
    preview.hidden = false;
    full.hidden = true;
    btn.textContent = btn.dataset.originalText || btn.textContent;
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
// v4.2.5: Multi-turn conversation with LocalStorage persistence
const QA_HISTORY_KEY = 'ace-mcp-qa-history';
let qaConversationHistory = JSON.parse(localStorage.getItem(QA_HISTORY_KEY) || '[]');

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

document.getElementById("run-ask")?.addEventListener("click", async () => {
  const askBtn = document.getElementById("run-ask");
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

  const timeoutSec = Number(document.getElementById("qa-timeout")?.value || 60);
  const projectRoot = projectRootInput.value;

  // Reset
  askBtn.disabled = true;
  askBtn.textContent = 'Thinking...';
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
    if (Date.now() - startTime > timeoutSec * 1000) {
      clearInterval(qaTimerInterval);
      // timeout handled below
    }
  }, 100);

  try {
    // Step 1: Index
    setStep(stepsEl, 'index', '📂', 'Checking project index (first time may take minutes)...', false);
    const indexStart = Date.now();
    await request("POST", "/api/index-project", { mode: "incremental", projectRootPath: projectRoot });
    const indexMs = Date.now() - indexStart;
    const indexNote = indexMs > 5000 ? ' (semantic index built)' : '';
    setStep(stepsEl, 'index', '📂', `Index ready (${indexMs}ms)${indexNote}`, true);

    // Step 2: Search
    const maxSources = Number(document.getElementById("qa-max-sources")?.value || 8);
    setStep(stepsEl, 'search', '🔍', `Searching top ${maxSources} relevant code snippets...`, false);
    const searchStart = Date.now();
    const searchData = await request("POST", "/api/search-context", {
      projectRootPath: projectRoot,
      query: question,
      mode: "auto",
      topK: maxSources,
      includeContextLines: 0,
      resultMode: "full",
    });
    const searchMs = Date.now() - searchStart;
    const resultCount = searchData?.data?.results?.length ?? 0;
    setStep(stepsEl, 'search', '🔍', `Found ${resultCount} relevant code snippets (${searchMs}ms)`, true);

    // Show search results immediately as source cards
    const searchResults = searchData?.data?.results || [];
    // Extract search terms from question for highlighting
    const searchTerms = question.split(/\s+/).filter(t => t.length > 2);
    if (searchResults.length) {
      const maxScore = Math.max(...searchResults.map(s => s.score || 0));
      const cards = searchResults.map((r, i) => renderSourceCard({
        index: i + 1, filePath: r.filePath, startLine: r.startLine, endLine: r.endLine,
        language: r.language, score: r.score, snippet: r.snippet || '',
      }, maxScore, searchTerms)).join('');
      sourcesListEl.innerHTML = `<h4>Retrieved sources (${searchResults.length})</h4>` + cards;
      sourcesListEl.hidden = false;
    }

    // Step 3: LLM with retry support
    const maxRetries = Number(document.getElementById("qa-retries")?.value || 2);
    let qaData = null;
    let llmMs = 0;
    let retryCount = 0;
    const llmStart = Date.now();

    while (retryCount <= maxRetries) {
      try {
        const attemptLabel = retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : '';
        setStep(stepsEl, 'llm', '🤖', `Generating answer with LLM...${attemptLabel}`, false);

        qaData = await request("POST", "/api/qa/ask", {
          projectRootPath: projectRoot,
          question,
          maxSources,
          includeSummary: document.getElementById("qa-include-summary")?.checked ?? true,
          timeoutSeconds: timeoutSec,
          // v4.2.4: Send conversation history for multi-turn support
          history: qaConversationHistory,
        });

        llmMs = Date.now() - llmStart;
        setStep(stepsEl, 'llm', '🤖', `Answer generated (${llmMs}ms, ${qaData?.usage?.completionTokens ?? '?'} tokens)${retryCount > 0 ? ` after ${retryCount} retry` : ''}`, true);
        break; // Success, exit retry loop
      } catch (err) {
        retryCount++;
        const isTimeout = err.message?.includes('timed out') || err.message?.includes('timeout');

        if (isTimeout && retryCount <= maxRetries) {
          setStep(stepsEl, 'llm', '⚠️', `LLM timeout, retrying (${retryCount}/${maxRetries})...`, false);
          await new Promise(r => setTimeout(r, 1000)); // Brief pause before retry
        } else {
          throw err; // Re-throw if not timeout or out of retries
        }
      }
    }

    if (!qaData) {
      throw new Error(`LLM failed after ${maxRetries} retries`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // v4.2.4: Handle fallback response (LLM unavailable)
    if (qaData?.fallback) {
      answerBodyEl.innerHTML = `<div class="qa-fallback-notice">⚠️ ${qaData.message || 'LLM 服务暂时不可用，以下是检索到的相关代码片段，您可以直接参考。'}</div>`;
      answerBodyEl.hidden = false;
      setStep(stepsEl, 'llm', '⚠️', `LLM ${qaData.fallbackReason === 'timeout' ? 'timeout' : 'unavailable'} - showing search results only`, true);
    }
    // Answer
    else if (qaData?.answer) {
      answerBodyEl.innerHTML = renderMarkdown(qaData.answer);
      answerBodyEl.hidden = false;

      // v4.2.5: Save to conversation history with LocalStorage persistence
      qaConversationHistory.push(
        { role: 'user', content: question },
        { role: 'assistant', content: qaData.answer }
      );
      saveQaHistory();

      // Show feedback buttons
      const feedbackEl = document.getElementById('qa-feedback');
      feedbackEl.hidden = false;
      // Store QA context for feedback submission
      feedbackEl.dataset.context = JSON.stringify({
        projectRootPath: projectRoot,
        question,
        answer: qaData.answer,
        sources: qaData.sources,
        usage: qaData.usage,
        timing: qaData.timing,
      });
      // Reset feedback UI state
      document.getElementById('qa-feedback-positive').classList.remove('selected');
      document.getElementById('qa-feedback-negative').classList.remove('selected');
      document.getElementById('qa-correction-form').hidden = true;
      document.getElementById('qa-feedback-thanks').hidden = true;
      document.getElementById('qa-feedback-positive').disabled = false;
      document.getElementById('qa-feedback-negative').disabled = false;
      document.getElementById('qa-correction').value = '';
    }

    // Update sources from QA response (may have different snippets)
    if (qaData?.sources?.length) {
      const maxScore = Math.max(...qaData.sources.map(s => s.score || 0));
      sourcesListEl.innerHTML = `<h4>Sources (${qaData.sources.length})</h4>` +
        qaData.sources.map(s => renderSourceCard(s, maxScore, searchTerms)).join('');
      sourcesListEl.hidden = false;
    }

    // Stats
    const statItems = [`<span class="qa-stat"><span class="qa-stat-label">Total:</span> ${elapsed}s</span>`];
    statItems.push(`<span class="qa-stat"><span class="qa-stat-label">Index:</span> ${indexMs}ms</span>`);
    statItems.push(`<span class="qa-stat"><span class="qa-stat-label">Search:</span> ${searchMs}ms</span>`);
    if (qaData?.timing?.llmMs) statItems.push(`<span class="qa-stat"><span class="qa-stat-label">LLM:</span> ${qaData.timing.llmMs}ms</span>`);
    if (qaData?.usage) {
      statItems.push(`<span class="qa-stat"><span class="qa-stat-label">Prompt:</span> ${qaData.usage.promptTokens} tok</span>`);
      statItems.push(`<span class="qa-stat"><span class="qa-stat-label">Completion:</span> ${qaData.usage.completionTokens} tok</span>`);
    }
    statsEl.innerHTML = statItems.join('');
    statsEl.hidden = false;

    // Raw JSON
    rawEl.innerHTML = `<details><summary>Show raw JSON</summary><pre>${escapeHtml(JSON.stringify(qaData, null, 2))}</pre></details>`;

  } catch (error) {
    const msg = error.message || String(error);
    errorEl.textContent = msg;
    errorEl.hidden = false;
  } finally {
    clearInterval(qaTimerInterval);
    qaTimerInterval = null;
    loadingEl.hidden = true;
    askBtn.disabled = false;
    askBtn.textContent = 'Ask';
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

// ── v4.2.5: SSE Streaming Ask ────────────────────────────────────────────────
document.getElementById("run-ask-stream")?.addEventListener("click", async () => {
  const askBtn = document.getElementById("run-ask-stream");
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
  askBtn.textContent = 'Streaming...';
  document.getElementById("run-ask").disabled = true;
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

  // Build query params
  const params = new URLSearchParams({
    projectRootPath: projectRoot,
    question,
    maxSources: String(maxSources),
    includeSummary: String(includeSummary),
    timeoutSeconds: String(timeoutSec),
    history: JSON.stringify(qaConversationHistory),
  });

  let fullAnswer = '';
  let finalData = null;
  const searchTerms = question.split(/\s+/).filter(t => t.length > 2);

  try {
    const eventSource = new EventSource(`/api/qa/ask/stream?${params}`);

    await new Promise((resolve, reject) => {
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);

          switch (data.type) {
            case 'phase':
              if (data.status === 'start') {
                const icons = { index: '📂', search: '🔍', summary: '📋', llm: '🤖' };
                const labels = {
                  index: 'Checking project index...',
                  search: 'Searching relevant code...',
                  summary: 'Loading project summary...',
                  llm: 'Generating answer (streaming)...',
                };
                setStep(stepsEl, data.phase, icons[data.phase] || '⏳', labels[data.phase] || data.phase, false);
              } else if (data.status === 'done') {
                const icons = { index: '📂', search: '🔍', summary: '📋', llm: '🤖' };
                let text = `${data.phase} done`;
                if (data.ms) text += ` (${data.ms}ms)`;
                if (data.resultCount !== undefined) text = `Found ${data.resultCount} snippets (${data.ms}ms)`;
                if (data.hadSummary !== undefined) text = data.hadSummary ? 'Summary loaded' : 'No summary';
                setStep(stepsEl, data.phase, icons[data.phase] || '✅', text, true);
              }
              break;

            case 'sources':
              if (data.sources?.length) {
                const maxScore = Math.max(...data.sources.map(s => s.score || 0));
                const cards = data.sources.map(s => renderSourceCard(s, maxScore, searchTerms)).join('');
                sourcesListEl.innerHTML = `<h4>Retrieved sources (${data.sources.length})</h4>` + cards;
                sourcesListEl.hidden = false;
              }
              break;

            case 'token':
              if (data.content) {
                fullAnswer += data.content;
                answerBodyEl.innerHTML = renderMarkdown(fullAnswer);
                answerBodyEl.hidden = false;
              }
              break;

            case 'done':
              finalData = data;
              eventSource.close();
              resolve();
              break;

            case 'error':
              eventSource.close();
              reject(new Error(data.error));
              break;
          }
        } catch (parseErr) {
          console.error('SSE parse error:', parseErr, e.data);
        }
      };

      eventSource.onerror = (e) => {
        eventSource.close();
        reject(new Error('SSE connection failed'));
      };
    });

    // Success - save conversation history
    if (fullAnswer) {
      qaConversationHistory.push(
        { role: 'user', content: question },
        { role: 'assistant', content: fullAnswer }
      );
      saveQaHistory();

      // Show feedback
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

    // Stats
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const statItems = [`<span class="qa-stat"><span class="qa-stat-label">Total:</span> ${elapsed}s</span>`];
    if (finalData?.timing?.indexMs) statItems.push(`<span class="qa-stat"><span class="qa-stat-label">Index:</span> ${finalData.timing.indexMs}ms</span>`);
    if (finalData?.timing?.searchMs) statItems.push(`<span class="qa-stat"><span class="qa-stat-label">Search:</span> ${finalData.timing.searchMs}ms</span>`);
    if (finalData?.timing?.llmMs) statItems.push(`<span class="qa-stat"><span class="qa-stat-label">LLM:</span> ${finalData.timing.llmMs}ms</span>`);
    if (finalData?.usage) {
      statItems.push(`<span class="qa-stat"><span class="qa-stat-label">Prompt:</span> ${finalData.usage.promptTokens} tok</span>`);
      statItems.push(`<span class="qa-stat"><span class="qa-stat-label">Completion:</span> ${finalData.usage.completionTokens} tok</span>`);
    }
    statsEl.innerHTML = statItems.join('');
    statsEl.hidden = false;

    rawEl.innerHTML = `<details><summary>Show raw JSON</summary><pre>${escapeHtml(JSON.stringify(finalData, null, 2))}</pre></details>`;

  } catch (error) {
    errorEl.textContent = error.message || String(error);
    errorEl.hidden = false;
  } finally {
    clearInterval(qaTimerInterval);
    qaTimerInterval = null;
    loadingEl.hidden = true;
    askBtn.disabled = false;
    askBtn.textContent = 'Stream';
    document.getElementById("run-ask").disabled = false;
  }
});
