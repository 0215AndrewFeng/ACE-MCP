import test from "node:test";
import assert from "node:assert/strict";

import { analyzeQuery, buildFtsQuery, estimateOptimalSources } from "./queryAnalyzer.js";

test("analyzeQuery keeps code identifiers dominant in mixed CJK identifier queries", () => {
  const analysis = analyzeQuery("matchForShow接口的具体业务逻辑");

  assert.equal(analysis.hasIdentifierLikeSegments, true);
  assert.deepEqual(analysis.identifiers, ["matchforshow"]);
  assert.equal(analysis.ftsQuery, "matchforshow*");
});

test("analyzeQuery segments CJK runs into bounded bigrams for search recall", () => {
  const analysis = analyzeQuery("假确认场景");

  assert.deepEqual(analysis.tokens.slice(0, 5), ["假确认场景", "假确", "确认", "认场", "场景"]);
  assert.equal(analysis.isSymbolLike, false);
});

test("buildFtsQuery normalizes path and symbol separators into prefix terms", () => {
  assert.equal(buildFtsQuery(["src/services/RefundService.process"]), "src* OR services* OR refundservice* OR process*");
});

test("estimateOptimalSources expands context for complex architecture questions", () => {
  assert.equal(estimateOptimalSources("find RefundService", 10), 5);
  assert.equal(estimateOptimalSources("这个订单退款流程的整体业务逻辑如何实现", 10), 15);
});
