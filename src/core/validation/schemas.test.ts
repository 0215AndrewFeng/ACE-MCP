import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import type { Settings } from "../common/types.js";
import { askCodebaseShape, callGraphShape, searchContextShape } from "./schemas.js";

const settings = {
  defaultTopK: 8,
  qaMaxSourcesMax: 100,
  qaMaxSourcesDefault: 10,
} as unknown as Settings;

const searchSchema = z.object(searchContextShape(settings));
const callGraphSchema = z.object(callGraphShape(settings));
const askSchema = z.object(askCodebaseShape(settings));

test("valid search input parses", () => {
  const parsed = searchSchema.parse({ projectRootPath: "/p", query: "foo", topK: 5 });
  assert.equal(parsed.query, "foo");
  assert.equal(parsed.topK, 5);
});

test("empty query / projectRootPath are rejected", () => {
  assert.equal(searchSchema.safeParse({ projectRootPath: "/p", query: "" }).success, false);
  assert.equal(searchSchema.safeParse({ projectRootPath: "", query: "foo" }).success, false);
});

test("out-of-range topK is rejected (strict)", () => {
  assert.equal(searchSchema.safeParse({ projectRootPath: "/p", query: "foo", topK: 999 }).success, false);
});

test("out-of-range includeContextLines is rejected (strict)", () => {
  assert.equal(searchSchema.safeParse({ projectRootPath: "/p", query: "foo", includeContextLines: 999 }).success, false);
});

test("out-of-range depth is rejected (strict)", () => {
  assert.equal(callGraphSchema.safeParse({ projectRootPath: "/p", query: "foo", depth: 99 }).success, false);
});

test("unknown mode / languages value is rejected (strict)", () => {
  assert.equal(searchSchema.safeParse({ projectRootPath: "/p", query: "foo", mode: "bogus" }).success, false);
  assert.equal(searchSchema.safeParse({ projectRootPath: "/p", query: "foo", languages: ["cobol"] }).success, false);
});

test("defaults are applied when fields omitted", () => {
  const parsed = searchSchema.parse({ projectRootPath: "/p", query: "foo" });
  assert.equal(parsed.mode, "auto");
  assert.equal(parsed.resultMode, "full");
  assert.equal(parsed.topK, 8);
  assert.equal(parsed.includeContextLines, 0);
});

test("askCodebase defaults contextMode to merged-file and maxSources to default", () => {
  const parsed = askSchema.parse({ projectRootPath: "/p", question: "what?" });
  assert.equal(parsed.contextMode, "merged-file");
  assert.equal(parsed.maxSources, 10);
  assert.equal(parsed.includeSummary, true);
});

test("askCodebase rejects empty question", () => {
  assert.equal(askSchema.safeParse({ projectRootPath: "/p", question: "" }).success, false);
});
