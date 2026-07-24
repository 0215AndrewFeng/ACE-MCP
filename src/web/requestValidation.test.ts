import test from "node:test";
import assert from "node:assert/strict";

import type { Settings } from "../core/common/types.js";
import { MAX_QUERY_LENGTH } from "../core/validation/schemas.js";
import {
  parseAskRequest,
  parseCallGraphRequest,
  parseFileSnippetRequest,
  parseIndexProjectRequest,
  parseProjectResolveRequest,
  parseSearchContextRequest,
} from "./requestValidation.js";

const settings = {
  defaultTopK: 8,
  qaMaxContextTokens: 48000,
  qaMaxContextTokensMax: 200000,
  qaMaxSourcesDefault: 15,
  qaMaxSourcesMax: 50,
} as Settings;

test("parseSearchContextRequest keeps web parsing lenient but clamps unsafe values", () => {
  const parsed = parseSearchContextRequest({
    enableReranker: true,
    includeContextLines: 9999,
    languages: "javascript,unknown,markdown",
    mode: "invalid",
    pathPrefix: "./src",
    projectRootPath: "/tmp/project",
    query: "refund",
    resultMode: "metadata",
    topK: 999,
  }, settings);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.mode, "auto");
  assert.equal(parsed.value.topK, 50);
  assert.equal(parsed.value.includeContextLines, 500);
  assert.deepEqual(parsed.value.filters.languages, ["javascript", "markdown"]);
  assert.equal(parsed.value.filters.pathPrefix, "src");
  assert.equal(parsed.value.enableReranker, true);
});

test("parseSearchContextRequest accepts larger context windows before clamping", () => {
  const parsed = parseSearchContextRequest({
    includeContextLines: 450,
    projectRootPath: "/tmp/project",
    query: "refund",
  }, settings);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.includeContextLines, 450);
});

test("web parsers reject only missing required fields", () => {
  assert.deepEqual(parseSearchContextRequest({ projectRootPath: "/tmp/project" }, settings), { ok: false, error: "query is required" });
  assert.deepEqual(parseFileSnippetRequest({ projectRootPath: "/tmp/project" }), { ok: false, error: "filePath is required" });
  assert.deepEqual(parseIndexProjectRequest({}), { ok: false, error: "projectRootPath is required" });
});

test("parseCallGraphRequest and parseAskRequest clamp request-specific fields", () => {
  const graph = parseCallGraphRequest({ projectRootPath: "/tmp/project", query: "refund", depth: 999 }, settings);
  assert.equal(graph.ok && graph.value.depth, 5);

  const ask = parseAskRequest({
    callChainDepth: 999,
    contextMode: "full-file",
    maxContextTokens: 999999,
    maxSources: 999,
    projectRootPath: "/tmp/project",
    question: "how does refund work?",
    retries: 999,
    timeoutSeconds: 999,
  }, settings);
  assert.equal(ask.ok, true);
  if (!ask.ok) return;
  assert.equal(ask.value.maxSources, 50);
  assert.equal(ask.value.maxContextTokens, 200000);
  assert.equal(ask.value.callChainDepth, 3);
  assert.equal(ask.value.retries, 5);
  assert.equal(ask.value.timeoutSeconds, 600);
});

test("parseAskRequest reports effective request parameters for Web display", () => {
  const ask = parseAskRequest({
    contextMode: "full-file",
    maxContextTokens: 999999,
    maxSources: 999,
    projectRootPath: "/tmp/project",
    question: "how does refund work?",
    retries: 999,
    timeoutSeconds: 999,
  }, settings);

  assert.equal(ask.ok, true);
  if (!ask.ok) return;
  assert.deepEqual(ask.value.effectiveParams, {
    callChainDepth: 1,
    contextMode: "full-file",
    includeSummary: true,
    maxContextTokens: 200000,
    maxSources: 50,
    retries: 5,
    timeoutSeconds: 600,
  });
});

test("parseProjectResolveRequest preserves at least two ambiguity candidates", () => {
  const parsed = parseProjectResolveRequest({ query: "FlowSwitcher", topK: 1 });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.topK, 2);
});

test("parseProjectResolveRequest rejects oversized routing queries", () => {
  assert.deepEqual(
    parseProjectResolveRequest({ query: "x".repeat(MAX_QUERY_LENGTH + 1) }),
    { ok: false, error: `query must contain at most ${MAX_QUERY_LENGTH} characters` },
  );
});
