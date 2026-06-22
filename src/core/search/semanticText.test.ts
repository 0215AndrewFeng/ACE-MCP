import test from "node:test";
import assert from "node:assert/strict";

import { buildCjkBigrams, buildSemanticFtsQuery, buildSemanticTerms, buildSemanticText } from "./semanticText.js";

test("buildCjkBigrams returns adjacent bigrams for CJK terms", () => {
  assert.deepEqual(buildCjkBigrams("退款流程"), ["退款", "款流", "流程"]);
  assert.deepEqual(buildCjkBigrams("refund"), []);
});

test("buildSemanticTerms splits identifiers and expands domain synonyms", () => {
  const terms = buildSemanticTerms("RefundService handles payment refund");

  assert.ok(terms.includes("refund"));
  assert.ok(terms.includes("service"));
  assert.ok(terms.includes("reimburse"));
  assert.ok(terms.includes("支付"));
});

test("buildSemanticFtsQuery uses CJK-aware term caps", () => {
  const asciiQuery = buildSemanticFtsQuery(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"]);
  assert.equal(asciiQuery, "alpha* OR bravo* OR charlie* OR delta* OR echo* OR foxtrot* OR golf* OR hotel*");

  const cjkTerms = buildSemanticTerms("退款流程状态变更");
  const cjkQuery = buildSemanticFtsQuery(cjkTerms);
  assert.ok(cjkQuery?.includes("退款*"));
  assert.ok(cjkQuery?.includes("流程*"));
});

test("buildSemanticText blends path, content, and symbol names", () => {
  const text = buildSemanticText("src/refund/RefundService.ts", "export function refundOrder() {}", ["RefundService", "refundOrder"]);

  assert.match(text, /refund/);
  assert.match(text, /service/);
  assert.match(text, /order/);
});
