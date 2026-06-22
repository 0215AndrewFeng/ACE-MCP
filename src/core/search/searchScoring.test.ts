import test from "node:test";
import assert from "node:assert/strict";

import type { SearchResult } from "../common/types.js";
import { analyzeQuery } from "./queryAnalyzer.js";
import {
  applyCallGraphResultMode,
  applyDefinitionResultMode,
  applyResultMode,
  buildResultSourceBreakdown,
  choosePreferredResult,
  mergeDefinitionMatches,
  mergeResults,
  rerankResults,
} from "./searchScoring.js";

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    endLine: 2,
    filePath: "src/refund/RefundService.ts",
    language: "javascript",
    reason: "lexical",
    score: 0.5,
    snippet: "function refundOrder() { return true; }",
    snippetIncluded: true,
    startLine: 1,
    symbol: "RefundService.refundOrder",
    ...overrides,
  };
}

test("choosePreferredResult compares scored candidates without mutating input scores", () => {
  const analysis = analyzeQuery("RefundService.refundOrder");
  const existing = result({ reason: "lexical", score: 0.2 });
  const incoming = result({ reason: "lexical+symbol", score: 0.2 });

  const preferred = choosePreferredResult(existing, incoming, analysis);

  assert.equal(preferred, incoming);
  assert.equal(existing.score, 0.2);
  assert.equal(incoming.score, 0.2);
});

test("mergeResults combines duplicate locations and clamps long snippets", () => {
  const merged = mergeResults([
    [result({ reason: "lexical", score: 2, snippet: "a".repeat(3000) })],
    [result({ reason: "symbol", score: 4 })],
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].reason, "lexical+symbol");
  assert.ok(merged[0].snippet.length < 2500);
});

test("rerankResults materializes explanations once and enforces per-file limits", () => {
  const analysis = analyzeQuery("refundOrder");
  const ranked = rerankResults([
    result({ startLine: 20, endLine: 21, symbol: "RefundService.other", score: 0.1 }),
    result({ score: 0.2 }),
  ], analysis, 10, 1);

  assert.equal(ranked.length, 1);
  assert.ok(ranked[0].explanation?.matchedTokens.includes("refundorder"));
});

test("result mode helpers omit snippets for metadata responses", () => {
  assert.equal(applyResultMode([result()], "metadata")[0].snippetIncluded, false);
  assert.equal(applyDefinitionResultMode([{
    endLine: 1,
    filePath: "src/a.ts",
    fullName: "A",
    kind: "class",
    language: "javascript",
    line: 1,
    name: "A",
    score: 1,
    signature: "class A {}",
    snippet: "class A {}",
    snippetIncluded: true,
    startLine: 1,
    symbolId: "s1",
  }], "metadata")[0].snippet, "");
  assert.equal(applyCallGraphResultMode([{
    callKind: "call",
    endLine: 2,
    filePath: "src/a.ts",
    hopCount: 1,
    language: "javascript",
    line: 2,
    rawName: "run",
    score: 1,
    snippet: "run()",
    snippetIncluded: true,
    startLine: 2,
    symbolPath: ["A.run"],
  }], "metadata")[0].snippetIncluded, false);
});

test("breakdown and definition merging prefer highest scoring unique definitions", () => {
  assert.deepEqual(buildResultSourceBreakdown([
    result({ reason: "lexical+symbol" }),
    result({ reason: "semantic" }),
  ]), { lexical: 1, semantic: 1, symbol: 1 });

  const definitions = mergeDefinitionMatches([
    {
      endLine: 1,
      filePath: "src/a.ts",
      fullName: "A",
      kind: "class",
      language: "javascript",
      line: 1,
      name: "A",
      score: 0.1,
      signature: "class A {}",
      snippet: "",
      snippetIncluded: true,
      startLine: 1,
      symbolId: "s1",
    },
    {
      endLine: 1,
      filePath: "src/a.ts",
      fullName: "A",
      kind: "class",
      language: "javascript",
      line: 1,
      name: "A",
      score: 0.9,
      signature: "class A {}",
      snippet: "",
      snippetIncluded: true,
      startLine: 1,
      symbolId: "s1",
    },
  ]);

  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].score, 0.9);
});
