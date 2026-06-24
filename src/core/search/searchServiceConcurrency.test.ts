import test from "node:test";
import assert from "node:assert/strict";

import { createTestProjectEnvironment } from "../../test/helpers.js";

test("SearchService.search yields the event loop while SQLite search work is pending", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/refund.ts": [
      "export class RefundService {",
      "  refundOrder() {",
      "    return 'refund';",
      "  }",
      "}",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    let timerFired = false;
    const timerPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });

    const response = await env.searchService.search(
      env.projectRootPath,
      "RefundService",
      "lexical",
      5,
      0,
      undefined,
      "metadata",
    );
    const timerFiredBeforeSearchResolved = timerFired;
    await timerPromise;

    assert.ok(response.results.length > 0);
    assert.equal(
      timerFiredBeforeSearchResolved,
      true,
      "SQLite search resolved before a 0ms timer could run, which means search work still occupied the main event-loop turn",
    );
  } finally {
    await env.cleanup();
  }
});
