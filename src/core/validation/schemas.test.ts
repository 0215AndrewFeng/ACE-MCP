import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import type { Settings } from "../common/types.js";
import { askCodebaseShape, callGraphShape, searchContextShape } from "./schemas.js";

const settings = {
  defaultTopK: 8,
  qaMaxSourcesMax: 100,
  qaMaxSourcesDefault: 10,
  qaMaxContextTokensMax: 200000,
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

test("askCodebase maxContextTokens is optional and bounded (#v4.5.12)", () => {
  // omitted → undefined (server default applies downstream)
  assert.equal(askSchema.parse({ projectRootPath: "/p", question: "q" }).maxContextTokens, undefined);
  // in-range value passes through
  assert.equal(askSchema.parse({ projectRootPath: "/p", question: "q", maxContextTokens: 80000 }).maxContextTokens, 80000);
  // above configured max is rejected
  assert.equal(askSchema.safeParse({ projectRootPath: "/p", question: "q", maxContextTokens: 999999 }).success, false);
  // below floor is rejected
  assert.equal(askSchema.safeParse({ projectRootPath: "/p", question: "q", maxContextTokens: 10 }).success, false);
});

test("askCodebase enableReranker is optional and strictly boolean (#v4.5.14)", () => {
  // omitted → undefined (falls back to settings.enableLlmReranker downstream)
  assert.equal(askSchema.parse({ projectRootPath: "/p", question: "q" }).enableReranker, undefined);
  // explicit true/false pass through (per-request override)
  assert.equal(askSchema.parse({ projectRootPath: "/p", question: "q", enableReranker: true }).enableReranker, true);
  assert.equal(askSchema.parse({ projectRootPath: "/p", question: "q", enableReranker: false }).enableReranker, false);
  // non-boolean rejected by strict schema
  assert.equal(askSchema.safeParse({ projectRootPath: "/p", question: "q", enableReranker: "yes" }).success, false);
});
