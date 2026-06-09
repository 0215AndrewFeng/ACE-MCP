import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampSnippet,
  differenceStringSets,
  hasBoundaryMatch,
  intersectStringSets,
  isCjkToken,
  normalizeCallGraphDepth,
  normalizeIncludeContextLines,
  normalizeSearchFilters,
  unionStringSets,
} from "./searchHelpers.js";

test("normalizeSearchFilters returns undefined for undefined input", () => {
  assert.equal(normalizeSearchFilters(undefined), undefined);
});

test("normalizeSearchFilters returns undefined when nothing meaningful remains", () => {
  assert.equal(normalizeSearchFilters({ languages: [], pathPrefix: "" }), undefined);
});

test("normalizeSearchFilters trims/normalizes path fields and dedups languages", () => {
  const result = normalizeSearchFilters({
    languages: ["java", "java", "python"],
    pathPrefix: "./Src/Auth/",
    pathContains: "Login",
    excludePathPrefix: "/Gen/",
  });
  assert.ok(result);
  assert.deepEqual(result.languages, ["java", "python"]);
  // normalizePathPrefix strips leading ./ and /, normalizes slashes, but does NOT lowercase
  assert.equal(result.pathPrefix, "Src/Auth/");
  assert.equal(result.pathContains, "Login");
  assert.equal(result.excludePathPrefix, "Gen/");
});

test("clampSnippet truncates long string and leaves short unchanged", () => {
  const short = "short snippet";
  assert.equal(clampSnippet(short), short);
  const long = "x".repeat(3000);
  const clamped = clampSnippet(long, 2400);
  assert.equal(clamped, `${"x".repeat(2400)}\n...`);
});

test("normalizeIncludeContextLines clamps to [0,50] and defaults", () => {
  assert.equal(normalizeIncludeContextLines(undefined), 0);
  assert.equal(normalizeIncludeContextLines(NaN), 0);
  assert.equal(normalizeIncludeContextLines(-5), 0);
  assert.equal(normalizeIncludeContextLines(10), 10);
  assert.equal(normalizeIncludeContextLines(999), 50);
});

test("normalizeCallGraphDepth clamps to [1,5]", () => {
  assert.equal(normalizeCallGraphDepth(undefined), 1);
  assert.equal(normalizeCallGraphDepth(0), 1);
  assert.equal(normalizeCallGraphDepth(3), 3);
  assert.equal(normalizeCallGraphDepth(99), 5);
});

test("isCjkToken detects CJK vs ascii", () => {
  assert.equal(isCjkToken("中文"), true);
  assert.equal(isCjkToken("abc"), false);
});

test("hasBoundaryMatch matches on word boundaries", () => {
  assert.equal(hasBoundaryMatch("user.login", "login"), true);
  assert.equal(hasBoundaryMatch("userLogin", "login"), false);
  assert.equal(hasBoundaryMatch("", "login"), false);
});

test("unionStringSets / intersectStringSets / differenceStringSets", () => {
  const left = new Set(["a", "b", "c"]);
  const right = new Set(["b", "c", "d"]);
  assert.deepEqual([...unionStringSets(left, right)].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual([...intersectStringSets(left, right)].sort(), ["b", "c"]);
  assert.deepEqual([...differenceStringSets(left, right)].sort(), ["a"]);
});
