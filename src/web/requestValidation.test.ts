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

test("out-of-range depth clamps to 5", () => {
  const result = parseCallGraphRequest({ projectRootPath: "/p", query: "foo", depth: 99 }, settings);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.depth, 5);
});
