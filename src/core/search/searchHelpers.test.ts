import test from "node:test";
import assert from "node:assert/strict";

import { parseStructuredQuery } from "./structuredQuery.js";
import {
  buildStructuredQueryAnalysis,
  evaluateStructuredNode,
  hasBoundaryMatch,
  normalizeCallGraphDepth,
  normalizeIncludeContextLines,
  normalizeSearchFilters,
  withTimeout,
} from "./searchHelpers.js";

test("withTimeout returns fallback when a promise exceeds the budget", async () => {
  const fast = await withTimeout(Promise.resolve("ok"), 50, "fallback");
  assert.deepEqual(fast, { result: "ok", timedOut: false });

  const slow = await withTimeout(new Promise<string>(() => undefined), 1, "fallback");
  assert.deepEqual(slow, { result: "fallback", timedOut: true });
});

test("normalizers clamp numeric request bounds and clean filters", () => {
  assert.equal(normalizeIncludeContextLines(999), 50);
  assert.equal(normalizeCallGraphDepth(999), 5);
  assert.deepEqual(normalizeSearchFilters({
    excludePathPrefix: "./dist",
    languages: ["javascript", "javascript", "unknown" as never],
    pathContains: "\\service",
    pathPrefix: "/src",
  }), {
    excludePathPrefix: "dist",
    languages: ["javascript"],
    pathContains: "service",
    pathPrefix: "src",
  });
});

test("evaluateStructuredNode applies AND OR NOT set semantics", () => {
  const universe = new Set(["a", "b", "c"]);
  const node = {
    left: { termId: "one", type: "term", value: "one", phrase: false },
    right: {
      operand: { termId: "two", type: "term", value: "two", phrase: false },
      type: "not",
    },
    type: "and",
  } as const;

  assert.deepEqual([...evaluateStructuredNode(node, new Map([
    ["one", new Set(["a", "b"])],
    ["two", new Set(["b"])],
  ]), universe)], ["a"]);
});

test("buildStructuredQueryAnalysis preserves structured metadata", () => {
  const parsed = parseStructuredQuery("path:src AND symbol:RefundService");
  assert.ok(parsed);

  const analysis = buildStructuredQueryAnalysis("path:src AND symbol:RefundService", parsed);
  assert.equal(analysis.structuredQuery?.isStructured, true);
  assert.deepEqual(analysis.structuredQuery?.fields, ["path", "symbol"]);
  assert.deepEqual(analysis.structuredQuery?.operators, ["AND"]);
});

test("hasBoundaryMatch respects code-token separators", () => {
  assert.equal(hasBoundaryMatch("refund-service.process", "service"), true);
  assert.equal(hasBoundaryMatch("refundservice", "service"), false);
});
