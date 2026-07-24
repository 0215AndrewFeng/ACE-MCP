import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PROJECT_ROUTE_IDENTIFIERS,
  MAX_PROJECT_ROUTE_TERMS,
  MAX_QUERY_LENGTH,
} from "../common/types.js";
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

test("SearchService bounds project routing payloads before worker IPC", async () => {
  const env = await createTestProjectEnvironment({});
  let captured: {
    exactSymbols: string[];
    ftsQuery: string | null;
    routeTerms: string[] | undefined;
  } | undefined;

  try {
    const worker = (env.searchService as unknown as {
      sqliteSearchWorker: {
        searchProjectRoutes: (
          ftsQuery: string | null,
          exactSymbols: string[],
          limit: number,
          excludedProjectRootPaths: string[],
          routeTerms?: string[],
        ) => Promise<[]>;
      };
    }).sqliteSearchWorker;
    worker.searchProjectRoutes = async (ftsQuery, exactSymbols, _limit, _excluded, routeTerms) => {
      captured = { exactSymbols, ftsQuery, routeTerms };
      return [];
    };
    const query = Array.from(
      { length: 100 },
      (_, index) => `LongIdentifier_${index}_${"x".repeat(80)}`,
    ).join(" ");

    await env.searchService.searchProjectRouteMatches(query, 50);

    assert.ok(captured);
    assert.ok((captured.ftsQuery?.length ?? 0) <= MAX_QUERY_LENGTH);
    assert.ok(captured.exactSymbols.length <= MAX_PROJECT_ROUTE_IDENTIFIERS);
    assert.ok((captured.routeTerms?.length ?? Number.POSITIVE_INFINITY) <= MAX_PROJECT_ROUTE_TERMS);
  } finally {
    await env.cleanup();
  }
});
