import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSearchFilterClause,
  matchesSearchFilters,
  normalizeComparablePath,
  normalizeModulePath,
  resolveImportSourceModule,
  safeJsonParse,
} from "./sqliteStoreHelpers.js";

test("safeJsonParse returns fallback and logs warning for corrupt JSON", () => {
  const warnings: unknown[] = [];
  const logger = { warn: (_message: string, meta?: unknown) => warnings.push(meta) };

  assert.deepEqual(safeJsonParse("[1,2]", [], logger as never, "valid"), [1, 2]);
  assert.deepEqual(safeJsonParse("{bad", ["fallback"], logger as never, "broken"), ["fallback"]);
  assert.equal(warnings.length, 1);
});

test("path normalization and filters are case-insensitive and slash-stable", () => {
  assert.equal(normalizeComparablePath(".\\SRC\\Service.ts"), "src/service.ts");
  assert.equal(matchesSearchFilters(
    { filePath: "SRC/refund/RefundService.ts", language: "javascript" },
    { languages: ["javascript"], pathPrefix: "src", pathContains: "refund", excludePathPrefix: "src/generated" },
  ), true);
  assert.equal(matchesSearchFilters(
    { filePath: "src/generated/RefundService.ts", language: "javascript" },
    { excludePathPrefix: "src/generated" },
  ), false);
});

test("buildSearchFilterClause emits SQL fragments and parameters in filter order", () => {
  const clause = buildSearchFilterClause({
    excludePathPrefix: "src/generated",
    languages: ["java", "javascript"],
    pathContains: "refund",
    pathPrefix: "src",
  });

  assert.match(clause.sql, /f\.language IN \(\?, \?\)/);
  assert.deepEqual(clause.parameters, ["java", "javascript", "src%", "%refund%", "src/generated%"]);
});

test("module path helpers resolve language-specific import paths", () => {
  assert.equal(normalizeModulePath("src/service/index.ts"), "src/service");
  assert.equal(resolveImportSourceModule("src/controllers/order.ts", "../service/refund", "javascript"), "src/service/refund");
  assert.equal(resolveImportSourceModule("pkg.module", "pkg.Types", "python"), "pkg.types");
});
