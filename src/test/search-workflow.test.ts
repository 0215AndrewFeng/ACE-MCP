import test from "node:test";
import assert from "node:assert/strict";

import { createTestProjectEnvironment } from "./helpers.js";

test("index and search workflow finds text, definitions, references, and call graph edges", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/orderController.ts": [
      "import { RefundService } from './refundService';",
      "export function handleRefund() {",
      "  const service = new RefundService();",
      "  return service.refundOrder('order-1');",
      "}",
      "",
    ].join("\n"),
    "src/refundService.ts": [
      "export class RefundService {",
      "  refundOrder(orderId: string) {",
      "    return `refund ${orderId}`;",
      "  }",
      "}",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const search = await env.searchService.search(env.projectRootPath, "refundOrder", "auto", 5);
    assert.ok(search.results.some((result) => result.filePath === "src/refundService.ts"));

    const definitions = await env.searchService.findDefinitions(env.projectRootPath, "RefundService.refundOrder", 5);
    assert.equal(definitions.results[0]?.filePath, "src/refundService.ts");

    const references = await env.searchService.findReferences(env.projectRootPath, "RefundService.refundOrder", 5);
    assert.ok(references.results.some((result) => result.filePath === "src/orderController.ts"));

    const callers = await env.searchService.findCallers(env.projectRootPath, "RefundService.refundOrder", 5);
    assert.ok(callers.results.some((result) => result.ownerSymbol === "handleRefund"));
  } finally {
    await env.cleanup();
  }
});
