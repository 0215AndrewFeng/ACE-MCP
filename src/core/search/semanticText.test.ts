import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSemanticFtsQuery, buildSemanticTerms } from "./semanticText.js";

test("buildSemanticFtsQuery keeps up to 15 terms for CJK queries (#37, v4.5.15)", () => {
  // 12 distinct CJK bigrams — the old flat cap of 8 would cut 4 of them
  const terms = ["假确", "确认", "认场", "场景", "退规", "规有", "特殊", "改签", "退票", "出票", "航班", "行程"];
  const query = buildSemanticFtsQuery(terms);
  assert.ok(query);
  const parts = query.split(" OR ");
  assert.equal(parts.length, 12, "all 12 CJK terms survive the cap");
  assert.ok(parts.includes("退规*"));
  assert.ok(parts.includes("行程*"));
});

test("buildSemanticFtsQuery caps CJK queries at 15 terms", () => {
  const sentence = "假确认场景的退规有什么特殊的吗这里再补一些字凑出超过十五个词条";
  const terms = buildSemanticTerms(sentence);
  const query = buildSemanticFtsQuery(terms);
  assert.ok(query);
  assert.ok(query.split(" OR ").length <= 15, "CJK cap is 15");
});

test("buildSemanticFtsQuery keeps the original cap of 8 for pure-ASCII queries", () => {
  const terms = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
  const query = buildSemanticFtsQuery(terms);
  assert.ok(query);
  assert.equal(query.split(" OR ").length, 8, "ASCII cap stays at 8");
});

test("buildSemanticFtsQuery returns null for empty terms", () => {
  assert.equal(buildSemanticFtsQuery([]), null);
});
