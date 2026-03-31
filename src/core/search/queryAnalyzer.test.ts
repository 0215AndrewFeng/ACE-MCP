import assert from "node:assert/strict";
import test from "node:test";

import { analyzeQuery } from "./queryAnalyzer.js";

test("analyzeQuery keeps Unicode tokens for natural-language queries", () => {
  const analysis = analyzeQuery("订单 退款处理");

  assert.deepEqual(analysis.tokens, ["订单", "退款处理"]);
  assert.equal(analysis.ftsQuery, "订单* OR 退款处理*");
  assert.equal(analysis.isPathLike, false);
  assert.equal(analysis.isSymbolLike, false);
});

test("analyzeQuery builds FTS-safe terms from path-like queries", () => {
  const analysis = analyzeQuery("src/退款.service.ts");

  assert.deepEqual(analysis.tokens, ["src/退款.service.ts"]);
  assert.equal(analysis.ftsQuery, "src* OR 退款* OR service* OR ts*");
  assert.equal(analysis.isPathLike, true);
  assert.equal(analysis.isSymbolLike, false);
});
