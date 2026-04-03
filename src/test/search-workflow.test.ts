import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { dotnetAdapter } from "../adapters/dotnet/index.js";
import { javascriptAdapter } from "../adapters/javascript/index.js";
import { javaAdapter } from "../adapters/java/index.js";
import { pythonAdapter } from "../adapters/python/index.js";
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

test("semantic mode matches conceptual synonyms in code identifiers", async () => {
  const environment = await createTestProjectEnvironment({
    "package.json": JSON.stringify({ name: "fixture" }),
    "src/auth/signInHandler.ts": "export const signInHandler = async () => 'ok';\n",
    "src/orders/OrderDao.ts": "export class OrderDao { insertOrder() { return true; } }\n",
  });

  try {
    await environment.indexCoordinator.indexProject(environment.projectRootPath, "incremental");

    const loginResponse = await environment.searchService.search(environment.projectRootPath, "login handler", "semantic", 5);
    assert.equal(loginResponse.results.some((result) => result.filePath === "src/auth/signInHandler.ts"), true);
    assert.equal(loginResponse.results.some((result) => result.reason.includes("semantic")), true);

    const repositoryResponse = await environment.searchService.search(environment.projectRootPath, "repository save order", "semantic", 5);
    assert.equal(repositoryResponse.results.some((result) => result.filePath === "src/orders/OrderDao.ts"), true);
  } finally {
    await environment.cleanup();
  }
});

test("Java Python and .NET adapters extract qualified types and methods", () => {
  const javaSymbols = javaAdapter.extractSymbols(
    "java-file",
    `
package com.example.refund;

public record RefundRequest(String id) {}

public class RefundService {
  public String processRefund(String id) {
    return id;
  }

  interface InnerGateway {
    String execute();
  }
}
`,
  );
  const javaKeys = new Set(javaSymbols.map((symbol) => `${symbol.kind}:${symbol.fullName}`));
  assert.equal(javaKeys.has("record:com.example.refund.RefundRequest"), true);
  assert.equal(javaKeys.has("class:com.example.refund.RefundService"), true);
  assert.equal(javaKeys.has("method:com.example.refund.RefundService.processRefund"), true);
  assert.equal(javaKeys.has("interface:com.example.refund.RefundService.InnerGateway"), true);
  assert.equal(javaKeys.has("method:com.example.refund.RefundService.InnerGateway.execute"), true);

  const pythonSymbols = pythonAdapter.extractSymbols(
    "python-file",
    `
class RefundService:
    async def process_refund(self, refund_id: str) -> str:
        return refund_id

    class Gateway:
        def execute(self):
            return True

def build_refund():
    return "ok"
`,
  );
  const pythonKeys = new Set(pythonSymbols.map((symbol) => `${symbol.kind}:${symbol.fullName}`));
  assert.equal(pythonKeys.has("class:RefundService"), true);
  assert.equal(pythonKeys.has("method:RefundService.process_refund"), true);
  assert.equal(pythonKeys.has("class:RefundService.Gateway"), true);
  assert.equal(pythonKeys.has("method:RefundService.Gateway.execute"), true);
  assert.equal(pythonKeys.has("function:build_refund"), true);

  const dotnetSymbols = dotnetAdapter.extractSymbols(
    "dotnet-file",
    `
namespace Refund.App.Services;

public record RefundRequest(string Id);

public class RefundService
{
    public async Task<string> ProcessRefund(string id)
    {
        return id;
    }

    internal interface Gateway
    {
        Task<string> ExecuteAsync();
    }
}
`,
  );
  const dotnetKeys = new Set(dotnetSymbols.map((symbol) => `${symbol.kind}:${symbol.fullName}`));
  assert.equal(dotnetKeys.has("record:Refund.App.Services.RefundRequest"), true);
  assert.equal(dotnetKeys.has("class:Refund.App.Services.RefundService"), true);
  assert.equal(dotnetKeys.has("method:Refund.App.Services.RefundService.ProcessRefund"), true);
  assert.equal(dotnetKeys.has("interface:Refund.App.Services.RefundService.Gateway"), true);
  assert.equal(dotnetKeys.has("method:Refund.App.Services.RefundService.Gateway.ExecuteAsync"), true);
});

test("symbol search returns improved Java Python and .NET definitions", async () => {
  const environment = await createTestProjectEnvironment({
    "pom.xml": "<project />\n",
    "pyproject.toml": "[project]\nname = 'fixture'\n",
    "Refund.App.csproj": "<Project />\n",
    "src/java/RefundService.java": `
package com.example.refund;

public class RefundService {
  public String processRefund(String id) {
    return id;
  }
}
`,
    "src/python/refund_service.py": `
class RefundService:
    def process_refund(self, refund_id: str) -> str:
        return refund_id
`,
    "src/dotnet/RefundService.cs": `
namespace Refund.App.Services;

public class RefundService
{
    public Task<string> ProcessRefund(string id)
    {
        return Task.FromResult(id);
    }
}
`,
  });

  try {
    await environment.indexCoordinator.indexProject(environment.projectRootPath, "incremental");

    const javaResponse = await environment.searchService.search(environment.projectRootPath, "processRefund", "symbol", 10, 0, {
      languages: ["java"],
    });
    assert.equal(javaResponse.results.some((result) => result.symbol === "processRefund"), true);
    assert.equal(javaResponse.results.some((result) => result.filePath === "src/java/RefundService.java"), true);

    const pythonResponse = await environment.searchService.search(environment.projectRootPath, "process_refund", "symbol", 10, 0, {
      languages: ["python"],
    });
    assert.equal(pythonResponse.results.some((result) => result.symbol === "process_refund"), true);
    assert.equal(pythonResponse.results.some((result) => result.filePath === "src/python/refund_service.py"), true);

    const dotnetResponse = await environment.searchService.search(environment.projectRootPath, "ProcessRefund", "symbol", 10, 0, {
      languages: ["dotnet"],
    });
    assert.equal(dotnetResponse.results.some((result) => result.symbol === "ProcessRefund"), true);
    assert.equal(dotnetResponse.results.some((result) => result.filePath === "src/dotnet/RefundService.cs"), true);
  } finally {
    await environment.cleanup();
  }
});
