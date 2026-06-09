import assert from "node:assert/strict";
import { test } from "node:test";

import type { VectorEntry } from "../common/types.js";
import {
  buildSearchFilterClause,
  matchesSearchFilters,
  normalizeComparablePath,
  normalizeModulePath,
  resolveImportSourceModule,
  safeJsonParse,
} from "./sqliteStoreHelpers.js";

type FilterEntry = Pick<VectorEntry, "filePath" | "language">;

test("safeJsonParse parses valid JSON array", () => {
  assert.deepEqual(safeJsonParse("[1,2]", [] as number[]), [1, 2]);
});

test("safeJsonParse parses valid JSON object", () => {
  assert.deepEqual(safeJsonParse('{"a":1}', {} as Record<string, number>), { a: 1 });
});

test("safeJsonParse returns fallback for null/empty/undefined", () => {
  assert.deepEqual(safeJsonParse(null, []), []);
  assert.deepEqual(safeJsonParse("", []), []);
  assert.deepEqual(safeJsonParse(undefined, []), []);
});

test("safeJsonParse returns fallback and warns once on corrupt JSON", () => {
  let count = 0;
  const logger = { debug() {}, info() {}, warn() { count += 1; }, error() {} };
  const result = safeJsonParse("{bad", ["fallback"], logger as any);
  assert.deepEqual(result, ["fallback"]);
  assert.equal(count, 1);
});

test("normalizeComparablePath normalizes slashes, leading ./ and /, lowercases", () => {
  assert.equal(normalizeComparablePath("Src\\Auth\\File.TS"), "src/auth/file.ts");
  assert.equal(normalizeComparablePath("./Foo/Bar.js"), "foo/bar.js");
  assert.equal(normalizeComparablePath("/Lead/Slash.py"), "lead/slash.py");
});

test("matchesSearchFilters returns true when filters undefined", () => {
  const entry: FilterEntry = { filePath: "a.ts", language: "javascript" };
  assert.equal(matchesSearchFilters(entry, undefined), true);
});

test("matchesSearchFilters respects languages include", () => {
  const entry: FilterEntry = { filePath: "a.ts", language: "javascript" };
  assert.equal(matchesSearchFilters(entry, { languages: ["javascript"] }), true);
  assert.equal(matchesSearchFilters(entry, { languages: ["python"] }), false);
});

test("matchesSearchFilters respects pathPrefix, pathContains, excludePathPrefix", () => {
  const entry: FilterEntry = { filePath: "src/auth/login.ts", language: "javascript" };
  assert.equal(matchesSearchFilters(entry, { pathPrefix: "src/auth" }), true);
  assert.equal(matchesSearchFilters(entry, { pathPrefix: "src/orders" }), false);
  assert.equal(matchesSearchFilters(entry, { pathContains: "login" }), true);
  assert.equal(matchesSearchFilters(entry, { pathContains: "logout" }), false);
  assert.equal(matchesSearchFilters(entry, { excludePathPrefix: "src/auth" }), false);
  assert.equal(matchesSearchFilters(entry, { excludePathPrefix: "src/orders" }), true);
});

test("buildSearchFilterClause returns empty for undefined filters", () => {
  assert.deepEqual(buildSearchFilterClause(undefined), { parameters: [], sql: "" });
});

test("buildSearchFilterClause builds language IN clause with parameters", () => {
  const { parameters, sql } = buildSearchFilterClause({ languages: ["java", "python"] });
  assert.match(sql, /f\.language IN \(\?, \?\)/);
  assert.deepEqual(parameters, ["java", "python"]);
});

test("buildSearchFilterClause builds LIKE / NOT LIKE with lowercased params", () => {
  const { parameters, sql } = buildSearchFilterClause({
    pathPrefix: "Src/Auth",
    excludePathPrefix: "Src/Gen",
  });
  assert.match(sql, /LOWER\(f\.relative_path\) LIKE \?/);
  assert.match(sql, /LOWER\(f\.relative_path\) NOT LIKE \?/);
  assert.ok(parameters.includes("src/auth%"));
  assert.ok(parameters.includes("src/gen%"));
});

test("normalizeModulePath returns null for null/empty", () => {
  assert.equal(normalizeModulePath(null), null);
  assert.equal(normalizeModulePath(""), null);
  assert.equal(normalizeModulePath(undefined), null);
});

test("normalizeModulePath strips extension and /index, lowercases", () => {
  assert.equal(normalizeModulePath("Src/Foo.TS"), "src/foo");
  assert.equal(normalizeModulePath("src/Bar/index.js"), "src/bar");
});

test("resolveImportSourceModule resolves javascript relative paths", () => {
  assert.equal(resolveImportSourceModule("src/auth/login.ts", "./helper", "javascript"), "src/auth/helper");
  assert.equal(resolveImportSourceModule("src/auth/login.ts", "../shared/util.js", "javascript"), "src/shared/util");
});

test("resolveImportSourceModule lowercases python modules", () => {
  assert.equal(resolveImportSourceModule("a.py", "MyPkg.Sub", "python"), "mypkg.sub");
});

test("resolveImportSourceModule normalizes default path", () => {
  assert.equal(resolveImportSourceModule("a.cs", "Some.Namespace.cs", "dotnet"), "some.namespace");
});
