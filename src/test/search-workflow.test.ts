import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { AppError } from "../core/common/errors.js";
import { readFileSnippet } from "../core/project/fileSnippet.js";
import { createTestProjectEnvironment } from "./helpers.js";

test("indexing and search filters work with normalized roots", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
    "src/legacy/service.ts": "export function refundHandler() {\n  return 'legacy';\n}\n",
    "src/refund/service.ts": "export function refundHandler() {\n  return 'refund';\n}\n",
    "src/refund/notes.ts": "export const refundNote = '退款处理';\n",
  });

  try {
    const indexed = await environment.indexCoordinator.indexProject(path.join(environment.projectRootPath, "."), "incremental");
    assert.equal(indexed.failedFileCount, 0);

    const response = await environment.searchService.search(
      path.join(environment.projectRootPath, "."),
      "refundHandler",
      "auto",
      10,
      0,
      {
        excludePathPrefix: "src/legacy",
        languages: ["javascript"],
        pathContains: "refund",
        pathPrefix: "src",
      },
      "metadata",
    );

    assert.equal(response.resultMode, "metadata");
    assert.ok(response.results.length >= 1);
    assert.equal(response.results.every((result) => result.filePath === "src/refund/service.ts"), true);
    assert.equal(response.results.every((result) => result.language === "javascript"), true);
    assert.equal(response.results.every((result) => result.snippet === ""), true);
    assert.equal(response.results.every((result) => result.snippetIncluded === false), true);

    const stats = environment.store.getProjectStats(path.join(environment.projectRootPath, "."));
    assert.ok(stats);
    assert.equal(stats?.projectRootPath, environment.projectRootPath);
    assert.equal(stats?.fileCount, 3);
  } finally {
    await environment.cleanup();
  }
});

test("Unicode content queries return lexical matches", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
    "src/refund/service.ts": "export function refundHandler() {\n  const message = '退款处理';\n  return message;\n}\n",
  });

  try {
    await environment.indexCoordinator.indexProject(environment.projectRootPath, "incremental");

    const response = await environment.searchService.search(environment.projectRootPath, "退款处理", "auto", 5);

    assert.ok(response.results.length >= 1);
    assert.equal(response.results.some((result) => result.filePath === "src/refund/service.ts"), true);
    assert.equal(response.results.some((result) => result.reason.includes("lexical")), true);
    assert.equal(response.results.some((result) => result.snippet.includes("退款处理")), true);
  } finally {
    await environment.cleanup();
  }
});

test("readFileSnippet blocks paths outside the project root", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
    "src/refund/service.ts": "line1\nline2\nline3\n",
  });

  try {
    await assert.rejects(
      () => readFileSnippet(path.join(environment.projectRootPath, "."), "../outside.txt", 1, 1),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "INVALID_PROJECT_PATH" &&
        error.message.includes("../outside.txt"),
    );

    const snippet = await readFileSnippet(path.join(environment.projectRootPath, "."), "./src/refund/service.ts", 1, 2);
    assert.equal(snippet.projectRootPath, environment.projectRootPath);
    assert.equal(snippet.filePath, "src/refund/service.ts");
    assert.equal(snippet.snippet, "line1\nline2");
  } finally {
    await environment.cleanup();
  }
});
