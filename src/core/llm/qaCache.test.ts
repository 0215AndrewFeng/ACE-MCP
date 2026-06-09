import assert from "node:assert/strict";
import { test } from "node:test";

import { QaCache } from "./qaCache.js";

const usage = { promptTokens: 1, completionTokens: 2 };

test("hashSource is deterministic and differs for different inputs", () => {
  const a = QaCache.hashSource("file.ts", 1, 10);
  const b = QaCache.hashSource("file.ts", 1, 10);
  assert.equal(a, b);
  assert.notEqual(a, QaCache.hashSource("file.ts", 1, 11));
  assert.notEqual(a, QaCache.hashSource("other.ts", 1, 10));
});

test("set then get with same question and sources returns the cached entry", () => {
  const cache = new QaCache();
  cache.set("what does foo do?", ["h1", "h2"], "foo does X", usage);
  const entry = cache.get("what does foo do?", ["h1", "h2"]);
  assert.ok(entry);
  assert.equal(entry.answer, "foo does X");
  assert.deepEqual(entry.usage, usage);
});

test("get is order-independent for source hashes", () => {
  const cache = new QaCache();
  cache.set("q", ["b", "a"], "ans", usage);
  assert.ok(cache.get("q", ["a", "b"]));
});

test("different question or sources returns null (miss)", () => {
  const cache = new QaCache();
  cache.set("q1", ["h1"], "ans", usage);
  assert.equal(cache.get("q2", ["h1"]), null);
  assert.equal(cache.get("q1", ["h2"]), null);
});

test("expired entries return null (TTL)", async () => {
  const cache = new QaCache(20, 100);
  cache.set("q", ["h1"], "ans", usage);
  assert.ok(cache.get("q", ["h1"]));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cache.get("q", ["h1"]), null);
});

test("evicts oldest entry when exceeding max size", () => {
  const cache = new QaCache(300_000, 2);
  cache.set("q1", ["h"], "a1", usage);
  cache.set("q2", ["h"], "a2", usage);
  cache.set("q3", ["h"], "a3", usage); // triggers eviction of q1
  assert.equal(cache.get("q1", ["h"]), null);
  assert.ok(cache.get("q2", ["h"]));
  assert.ok(cache.get("q3", ["h"]));
  assert.equal(cache.getStats().size, 2);
});
