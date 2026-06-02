import assert from "node:assert/strict";
import test from "node:test";

import { analyzeQuery } from "./queryAnalyzer.js";
import { collectPositiveStructuredTerms, parseStructuredQuery } from "./structuredQuery.js";

test("analyzeQuery keeps Unicode tokens for natural-language queries", () => {
  const analysis = analyzeQuery("订单 退款处理");

  assert.deepEqual(analysis.tokens, ["订单", "退款处理"]);
  assert.equal(analysis.ftsQuery, "订单* OR 退款处理*");
  assert.equal(analysis.isPathLike, false);
  assert.equal(analysis.isSymbolLike, false);
});

test("analyzeQuery builds FTS-safe terms from path-like queries", () => {
  const analysis = analyzeQuery("src/退款.service.ts");

  // ASCII/CJK boundary split separates the identifier parts from the CJK term
  assert.deepEqual(analysis.tokens, ["src/", "退款", ".service.ts"]);
  assert.equal(analysis.ftsQuery, "src* OR 退款* OR service* OR ts*");
  assert.equal(analysis.isPathLike, true);
  assert.equal(analysis.isSymbolLike, false);
});

test("analyzeQuery builds semantic terms with synonym expansion", () => {
  const analysis = analyzeQuery("login handler");

  assert.equal(analysis.semanticTerms.includes("login"), true);
  assert.equal(analysis.semanticTerms.includes("signin"), true);
  assert.equal(analysis.semanticTerms.includes("auth"), true);
  assert.equal(analysis.semanticTerms.includes("handler"), true);
  assert.equal(analysis.semanticTerms.includes("controller"), true);
  assert.equal(analysis.hasIdentifierLikeSegments, false);
});

test("analyzeQuery flags compound identifiers inside mixed natural-language queries", () => {
  const analysis = analyzeQuery("MyWorkOrderController GetMyWorkOrders work order query flow");

  assert.equal(analysis.hasIdentifierLikeSegments, true);
  assert.deepEqual(analysis.tokens, [
    "myworkordercontroller",
    "getmyworkorders",
    "work",
    "order",
    "query",
    "flow",
  ]);
});

test("parseStructuredQuery handles scoped fields boolean operators and phrases", () => {
  const parsed = parseStructuredQuery('symbol:RefundService AND (path:src/refund OR content:"refund flow") NOT path:test');

  assert.ok(parsed);
  assert.deepEqual(parsed.fields.sort(), ["content", "path", "symbol"]);
  assert.equal(parsed.operators.includes("AND"), true);
  assert.equal(parsed.operators.includes("OR"), true);
  assert.equal(parsed.operators.includes("NOT"), true);
  assert.equal(parsed.terms.length, 4);
  assert.deepEqual(parsed.terms.map((term) => ({ field: term.field, phrase: term.phrase, value: term.value })), [
    { field: "symbol", phrase: false, value: "RefundService" },
    { field: "path", phrase: false, value: "src/refund" },
    { field: "content", phrase: true, value: "refund flow" },
    { field: "path", phrase: false, value: "test" },
  ]);
});

test("collectPositiveStructuredTerms excludes negated clauses", () => {
  const parsed = parseStructuredQuery("symbol:RefundService AND NOT path:test");

  assert.ok(parsed);
  assert.deepEqual([...collectPositiveStructuredTerms(parsed.root)], ["term-1"]);
});
