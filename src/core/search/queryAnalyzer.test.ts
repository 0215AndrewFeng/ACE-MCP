import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeQuery,
  boundProjectRouteTerms,
  buildFtsQuery,
  estimateOptimalSources,
} from "./queryAnalyzer.js";

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

test("analyzeQuery preserves mixed ASCII and CJK business terms for exact routing", () => {
  const analysis = analyzeQuery("退规计算 A转D A转D历史逻辑 refund rule A to D");

  assert.ok(analysis.tokens.includes("a转d"));
  assert.ok(analysis.naturalLanguage.includes("a转d"));
  assert.match(analysis.ftsQuery ?? "", /(?:^| OR )a转d\*/);
  assert.equal(boundProjectRouteTerms(analysis.tokens).includes("to"), false);
});

test("buildFtsQuery normalizes path and symbol separators into prefix terms", () => {
  assert.equal(buildFtsQuery(["src/services/RefundService.process"]), "src* OR services* OR refundservice* OR process*");
});

test("estimateOptimalSources expands context for complex architecture questions", () => {
  assert.equal(estimateOptimalSources("find RefundService", 10), 5);
  assert.equal(estimateOptimalSources("这个订单退款流程的整体业务逻辑如何实现", 10), 15);
});
