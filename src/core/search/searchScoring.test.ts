import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueryAnalysis, SearchResult } from "../common/types.js";
import {
  dedupeSameFileResults,
  mergeOverlappingResults,
  mergeResults,
  normalizeSourceScores,
  scoreMergedResult,
} from "./searchScoring.js";

function makeAnalysis(rawQuery: string, tokens: string[]): QueryAnalysis {
  return {
    ftsQuery: null,
    hasIdentifierLikeSegments: false,
    identifiers: [],
    isPathLike: false,
    isSymbolLike: false,
    naturalLanguage: [],
    rawQuery,
    semanticTerms: [],
    tokens,
  };
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    endLine: 10,
    filePath: "src/foo.ts",
    language: "javascript",
    reason: "lexical",
    score: 1,
    snippet: "function foo() {}",
    snippetIncluded: true,
    startLine: 1,
    symbol: "foo",
    ...overrides,
  };
}

test("scoreMergedResult rewards token coverage and exact symbol match", () => {
  const analysis = makeAnalysis("foo", ["foo"]);
  const scored = scoreMergedResult(makeResult({ score: 1, symbol: "foo" }), analysis);
  // exact symbol match (+1.15) and full token coverage (+0.45) raise the base score
  assert.ok(scored.score > 1);
  assert.equal(scored.explanation.symbolMatch, "exact");
  assert.deepEqual(scored.explanation.matchedTokens, ["foo"]);
});

test("dedupeSameFileResults keeps at most perFileLimit per file", () => {
  const analysis = makeAnalysis("foo", ["foo"]);
  const results: SearchResult[] = [
    makeResult({ filePath: "a.ts", symbol: "one", startLine: 1, endLine: 5, score: 3 }),
    makeResult({ filePath: "a.ts", symbol: "two", startLine: 20, endLine: 25, score: 2 }),
    makeResult({ filePath: "a.ts", symbol: "three", startLine: 40, endLine: 45, score: 1 }),
  ];
  const deduped = dedupeSameFileResults(results, analysis, 2);
  assert.equal(deduped.length, 2);
  assert.ok(deduped.every((r) => r.filePath === "a.ts"));
});

test("mergeOverlappingResults merges results overlapping >50%", () => {
  const analysis = makeAnalysis("foo", ["foo"]);
  const results: SearchResult[] = [
    makeResult({ symbol: "a", startLine: 1, endLine: 10, score: 2 }),
    makeResult({ symbol: "b", startLine: 2, endLine: 11, score: 1 }),
  ];
  const merged = mergeOverlappingResults(results, analysis);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].startLine, 1);
  assert.equal(merged[0].endLine, 11);
});

test("mergeOverlappingResults keeps non-overlapping results separate", () => {
  const analysis = makeAnalysis("foo", ["foo"]);
  const results: SearchResult[] = [
    makeResult({ symbol: "a", startLine: 1, endLine: 5 }),
    makeResult({ symbol: "b", startLine: 50, endLine: 55 }),
  ];
  const merged = mergeOverlappingResults(results, analysis);
  assert.equal(merged.length, 2);
});

test("mergeResults dedups by file+line+symbol and sums scores", () => {
  const setA: SearchResult[] = [makeResult({ filePath: "a.ts", startLine: 1, endLine: 5, symbol: "x", reason: "lexical", score: 1 })];
  const setB: SearchResult[] = [makeResult({ filePath: "a.ts", startLine: 1, endLine: 5, symbol: "x", reason: "symbol", score: 1 })];
  const merged = mergeResults([setA, setB]);
  assert.equal(merged.length, 1);
  // reasons combined and sorted
  assert.equal(merged[0].reason, "lexical+symbol");
  // single-element sets are not normalized, so scores sum
  assert.equal(merged[0].score, 2);
});

test("mergeResults keeps distinct locations separate", () => {
  const setA: SearchResult[] = [
    makeResult({ filePath: "a.ts", startLine: 1, endLine: 5, symbol: "x" }),
    makeResult({ filePath: "b.ts", startLine: 1, endLine: 5, symbol: "y" }),
  ];
  const merged = mergeResults([setA]);
  assert.equal(merged.length, 2);
});

test("normalizeSourceScores maps scores into [0,1]", () => {
  const results: SearchResult[] = [
    makeResult({ filePath: "a.ts", score: 2 }),
    makeResult({ filePath: "b.ts", score: 6 }),
    makeResult({ filePath: "c.ts", score: 10 }),
  ];
  const normalized = normalizeSourceScores(results);
  for (const r of normalized) {
    assert.ok(r.score >= 0 && r.score <= 1, `score ${r.score} should be in [0,1]`);
  }
  assert.equal(Math.min(...normalized.map((r) => r.score)), 0);
  assert.equal(Math.max(...normalized.map((r) => r.score)), 1);
});

test("normalizeSourceScores returns single result unchanged", () => {
  const results: SearchResult[] = [makeResult({ score: 42 })];
  const normalized = normalizeSourceScores(results);
  assert.equal(normalized[0].score, 42);
});
