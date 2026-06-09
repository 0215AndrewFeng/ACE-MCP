import assert from "node:assert/strict";
import { test } from "node:test";

import type { Settings } from "../core/common/types.js";
import {
  parseAskRequest,
  parseCallGraphRequest,
  parseSearchContextRequest,
} from "./requestValidation.js";

const settings = {
  defaultTopK: 8,
  qaMaxSourcesMax: 100,
  qaMaxSourcesDefault: 10,
  qaMaxContextTokensMax: 200000,
} as unknown as Settings;

test("valid search request parses with coerced values", () => {
  const result = parseSearchContextRequest({ projectRootPath: "/p", query: "foo", topK: 5 }, settings);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.query, "foo");
    assert.equal(result.value.topK, 5);
  }
});

test("missing/empty required fields return ok:false", () => {
  assert.equal(parseSearchContextRequest({ query: "foo" }, settings).ok, false);
  assert.equal(parseSearchContextRequest({ projectRootPath: "/p", query: "" }, settings).ok, false);
  assert.equal(parseAskRequest({ projectRootPath: "/p", question: "" }, settings).ok, false);
});

test("topK 999 clamps to 50 (not rejected)", () => {
  const result = parseSearchContextRequest({ projectRootPath: "/p", query: "foo", topK: 999 }, settings);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.topK, 50);
});

test("topK string '5' coerces to 5", () => {
  const result = parseSearchContextRequest({ projectRootPath: "/p", query: "foo", topK: "5" }, settings);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.topK, 5);
});

test("unknown mode falls back to auto", () => {
  const result = parseSearchContextRequest({ projectRootPath: "/p", query: "foo", mode: "bogus" }, settings);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.mode, "auto");
});

test("languages comma-string splits into array", () => {
  const result = parseSearchContextRequest({ projectRootPath: "/p", query: "foo", languages: "java,python" }, settings);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.filters.languages, ["java", "python"]);
});

test("contextMode omitted defaults to merged-file", () => {
  const result = parseAskRequest({ projectRootPath: "/p", question: "what?" }, settings);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.contextMode, "merged-file");
});

test("maxContextTokens omitted is undefined, oversized clamps to max (#v4.5.12)", () => {
  const omitted = parseAskRequest({ projectRootPath: "/p", question: "q" }, settings);
  assert.equal(omitted.ok, true);
  if (omitted.ok) assert.equal(omitted.value.maxContextTokens, undefined);

  const oversized = parseAskRequest({ projectRootPath: "/p", question: "q", maxContextTokens: 999999 }, settings);
  assert.equal(oversized.ok, true);
  if (oversized.ok) assert.equal(oversized.value.maxContextTokens, 200000);

  const inRange = parseAskRequest({ projectRootPath: "/p", question: "q", maxContextTokens: 80000 }, settings);
  assert.equal(inRange.ok, true);
  if (inRange.ok) assert.equal(inRange.value.maxContextTokens, 80000);
});

test("out-of-range depth clamps to 5", () => {
  const result = parseCallGraphRequest({ projectRootPath: "/p", query: "foo", depth: 99 }, settings);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.depth, 5);
});
