import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { javascriptAdapter } from "../adapters/javascript/index.js";
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

test("AST-based JavaScript adapter extracts classes, interfaces, methods, enums, and object members", () => {
  const content = `
export interface RefundGateway {
  executeRefund(input: string): Promise<string>;
  findRefund: (id: string) => Promise<string>;
}

export enum RefundStatus {
  Pending = "pending",
  Done = "done"
}

export class RefundService implements RefundGateway {
  async executeRefund(input: string): Promise<string> {
    return input.trim();
  }

  findRefund = async (id: string): Promise<string> => id;
}

export const buildRefund = async (reason: string) => reason.trim();

export const refundRegistry = {
  createRecord(id: string) {
    return { id };
  },
  findRecord: async (id: string) => id,
  nested: {
    normalizeCode(code: string) {
      return code.trim();
    }
  }
};

export const InlineRefundService = class {
  run() {
    return true;
  }
};
`;

  const symbols = javascriptAdapter.extractSymbols("fixture-file", content);
  const keys = new Set(symbols.map((symbol) => `${symbol.kind}:${symbol.fullName}`));

  assert.equal(keys.has("interface:RefundGateway"), true);
  assert.equal(keys.has("method:RefundGateway.executeRefund"), true);
  assert.equal(keys.has("method:RefundGateway.findRefund"), true);
  assert.equal(keys.has("enum:RefundStatus"), true);
  assert.equal(keys.has("class:RefundService"), true);
  assert.equal(keys.has("method:RefundService.executeRefund"), true);
  assert.equal(keys.has("method:RefundService.findRefund"), true);
  assert.equal(keys.has("function:buildRefund"), true);
  assert.equal(keys.has("method:refundRegistry.createRecord"), true);
  assert.equal(keys.has("method:refundRegistry.findRecord"), true);
  assert.equal(keys.has("method:refundRegistry.nested.normalizeCode"), true);
  assert.equal(keys.has("class:InlineRefundService"), true);
  assert.equal(keys.has("method:InlineRefundService.run"), true);
});

test("symbol search returns AST-extracted JavaScript and TypeScript definitions", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
    "src/refund/service.ts": `
export interface RefundGateway {
  executeRefund(input: string): Promise<string>;
}

export class RefundService implements RefundGateway {
  async executeRefund(input: string): Promise<string> {
    return input.trim();
  }
}

export const refundRegistry = {
  createRecord(id: string) {
    return { id };
  }
};
`,
  });

  try {
    await environment.indexCoordinator.indexProject(environment.projectRootPath, "incremental");

    const interfaceResponse = await environment.searchService.search(environment.projectRootPath, "RefundGateway", "symbol", 10);
    assert.equal(interfaceResponse.results.some((result) => result.symbol === "RefundGateway"), true);

    const methodResponse = await environment.searchService.search(environment.projectRootPath, "createRecord", "symbol", 10);
    assert.equal(methodResponse.results.some((result) => result.symbol === "createRecord"), true);
    assert.equal(methodResponse.results.some((result) => result.filePath === "src/refund/service.ts"), true);
  } finally {
    await environment.cleanup();
  }
});

test("phrase matches rank exact snippets ahead of split-token matches", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
    "src/refund/exact.ts": "export const message = 'refund create flow';\n",
    "src/refund/scattered.ts": "export const refund = true;\nexport const createHandler = () => 'flow';\n",
  });

  try {
    await environment.indexCoordinator.indexProject(environment.projectRootPath, "incremental");

    const response = await environment.searchService.search(environment.projectRootPath, "refund create flow", "auto", 5);
    assert.equal(response.results[0]?.filePath, "src/refund/exact.ts");
  } finally {
    await environment.cleanup();
  }
});

test("same-file search results are deduplicated to the strongest few matches", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
    "src/refund/service.ts": `
export class RefundService {
  createRefundRecord() {
    return "record";
  }

  createRefundReceipt() {
    return "receipt";
  }

  createRefundReport() {
    return "report";
  }
}
`,
  });

  try {
    await environment.indexCoordinator.indexProject(environment.projectRootPath, "incremental");

    const response = await environment.searchService.search(environment.projectRootPath, "createRefund", "symbol", 10);
    const sameFileResults = response.results.filter((result) => result.filePath === "src/refund/service.ts");

    assert.equal(sameFileResults.length <= 2, true);
    assert.equal(sameFileResults.every((result) => result.symbol?.startsWith("createRefund")), true);
  } finally {
    await environment.cleanup();
  }
});

test("multi-token Chinese queries can match content split across nearby text", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
    "src/refund/chinese.ts": "export const message = '退款申请已经处理完成';\n",
  });

  try {
    await environment.indexCoordinator.indexProject(environment.projectRootPath, "incremental");

    const response = await environment.searchService.search(environment.projectRootPath, "退款 处理", "auto", 5);

    assert.equal(response.results.some((result) => result.filePath === "src/refund/chinese.ts"), true);
    assert.equal(response.results.some((result) => result.reason.includes("lexical")), true);
  } finally {
    await environment.cleanup();
  }
});
