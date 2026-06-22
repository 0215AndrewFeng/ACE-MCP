import test from "node:test";
import assert from "node:assert/strict";

import { QaCache } from "./qaCache.js";

test("QaCache keys are question-normalized and source-order independent", () => {
  const cache = new QaCache(60_000, 10);

  cache.set(" What is refund? ", ["b", "a"], "answer", { completionTokens: 2, promptTokens: 1 });

  assert.equal(cache.get("what is refund?", ["a", "b"])?.answer, "answer");
});

test("QaCache includes source content in source hashes", () => {
  const before = QaCache.hashSource("src/a.ts", 1, 3, "old content");
  const after = QaCache.hashSource("src/a.ts", 1, 3, "new content");

  assert.notEqual(before, after);
});

test("QaCache evicts expired and oldest entries", () => {
  const expired = new QaCache(-1, 10);
  expired.set("q", ["a"], "answer", { completionTokens: 1, promptTokens: 1 });
  assert.equal(expired.get("q", ["a"]), null);

  const limited = new QaCache(60_000, 1);
  limited.set("q1", ["a"], "one", { completionTokens: 1, promptTokens: 1 });
  limited.set("q2", ["b"], "two", { completionTokens: 1, promptTokens: 1 });
  assert.equal(limited.get("q1", ["a"]), null);
  assert.equal(limited.get("q2", ["b"])?.answer, "two");
});
