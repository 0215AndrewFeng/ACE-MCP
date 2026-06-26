import test from "node:test";
import assert from "node:assert/strict";

import { z } from "zod";

import type { Settings } from "../common/types.js";
import {
  MAX_INCLUDE_CONTEXT_LINES,
  SEARCH_FILTER_LANGUAGES,
  TOPK_MAX,
  askCodebaseShape,
  searchContextShape,
} from "./schemas.js";

const settings = {
  defaultTopK: 8,
  qaMaxContextTokensMax: 200000,
  qaMaxSourcesDefault: 15,
  qaMaxSourcesMax: 50,
} as Settings;

test("searchContextShape applies shared defaults and bounds", () => {
  assert.equal(MAX_INCLUDE_CONTEXT_LINES, 200);

  const schema = z.object(searchContextShape(settings));
  const parsed = schema.parse({
    includeContextLines: MAX_INCLUDE_CONTEXT_LINES,
    languages: ["javascript"],
    projectRootPath: "/tmp/project",
    query: "refund",
  });

  assert.equal(parsed.mode, "auto");
  assert.equal(parsed.resultMode, "full");
  assert.equal(parsed.topK, settings.defaultTopK);
  assert.deepEqual(parsed.languages, ["javascript"]);
  assert.throws(() => schema.parse({ projectRootPath: "/tmp/project", query: "refund", topK: TOPK_MAX + 1 }), /Number must be less than or equal/);
  assert.throws(() => schema.parse({
    includeContextLines: MAX_INCLUDE_CONTEXT_LINES + 1,
    projectRootPath: "/tmp/project",
    query: "refund",
  }), /Number must be less than or equal/);
});

test("askCodebaseShape constrains QA source and context limits", () => {
  const schema = z.object(askCodebaseShape(settings));

  const parsed = schema.parse({
    projectRootPath: "/tmp/project",
    question: "how does refund work?",
  });

  assert.equal(parsed.maxSources, 15);
  assert.equal(parsed.contextMode, "merged-file");
  assert.throws(() => schema.parse({
    maxContextTokens: 999,
    projectRootPath: "/tmp/project",
    question: "how?",
  }), /Number must be greater than or equal/);
});

test("shared language enum includes markdown for all request layers", () => {
  assert.ok(SEARCH_FILTER_LANGUAGES.includes("markdown"));
});
