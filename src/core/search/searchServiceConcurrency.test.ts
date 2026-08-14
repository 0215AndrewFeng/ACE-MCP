import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PROJECT_ROUTE_IDENTIFIERS,
  MAX_PROJECT_ROUTE_TERMS,
  MAX_QUERY_LENGTH,
} from "../common/types.js";
import { AppError } from "../common/errors.js";
import {
  SQLiteSearchWorkerOverloadError,
  SQLiteSearchWorkerQueueTimeoutError,
} from "../storage/sqliteSearchWorkerClient.js";
import { createTestProjectEnvironment } from "../../test/helpers.js";

test("SearchService combines SQLite candidate strategies into one worker request", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/refund.ts": "export class RefundService { refundOrder() { return '退款'; } }\n",
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    const worker = (env.searchService as unknown as {
      sqliteSearchWorker: Record<string, (...args: unknown[]) => Promise<unknown>>;
    }).sqliteSearchWorker;
    let combinedCalls = 0;
    worker.searchCandidates = async () => {
      combinedCalls += 1;
      return {
        identifierBoost: { durationMs: 0, results: [] },
        lexical: {
          durationMs: 1,
          results: [{
            endLine: 1,
            filePath: "src/refund.ts",
            language: "javascript",
            reason: "lexical",
            score: 1,
            snippet: "export class RefundService {}",
            snippetIncluded: true,
            startLine: 1,
          }],
        },
        path: { durationMs: 0, results: [] },
        semanticFts: { durationMs: 0, results: [] },
        symbol: { durationMs: 0, results: [] },
        unicodeSubstring: { durationMs: 0, results: [] },
      };
    };
    for (const method of [
      "searchByText",
      "searchBySemantic",
      "searchByTextSubstrings",
      "searchBySymbols",
      "searchByPath",
    ]) {
      worker[method] = async () => {
        throw new Error(`${method} must not be called separately`);
      };
    }

    const response = await env.searchService.search(
      env.projectRootPath,
      "RefundService 退款",
      "hybrid",
      5,
      0,
      undefined,
      "metadata",
    );

    assert.equal(combinedCalls, 1);
    assert.equal(response.results[0]?.filePath, "src/refund.ts");
    assert.ok(response.results[0]?.explanation?.matchedSources.includes("lexical"));
    assert.ok(response.diagnostics.executedStrategies.some((phase) => phase.name === "lexical"));
  } finally {
    await env.cleanup();
  }
});

test("identical cold SearchService queries reuse the same in-flight response", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/refund.ts": "export class RefundService {}\n",
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    const worker = (env.searchService as unknown as {
      sqliteSearchWorker: {
        searchCandidates: (...args: unknown[]) => Promise<unknown>;
      };
    }).sqliteSearchWorker;
    let combinedCalls = 0;
    let release: (() => void) | undefined;
    worker.searchCandidates = async () => {
      combinedCalls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      const empty = { durationMs: 0, results: [] };
      return {
        identifierBoost: empty,
        lexical: empty,
        path: empty,
        semanticFts: empty,
        symbol: empty,
        unicodeSubstring: empty,
      };
    };

    const first = env.searchService.search(env.projectRootPath, "RefundService", "lexical", 5, 0, undefined, "metadata");
    const second = env.searchService.search(env.projectRootPath, "RefundService", "lexical", 5, 0, undefined, "metadata");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(combinedCalls, 1);
    release?.();
    assert.deepEqual(await first, await second);
  } finally {
    await env.cleanup();
  }
});

for (const failure of [
  {
    code: "SEARCH_OVERLOADED",
    create: () => new SQLiteSearchWorkerOverloadError("SQLite search worker queue is full"),
  },
  {
    code: "SEARCH_TIMEOUT",
    create: () => new SQLiteSearchWorkerQueueTimeoutError("SQLite search worker request deadline exceeded"),
  },
]) {
  test(`SearchService exposes ${failure.code} as retryable 503 without caching it`, async () => {
    const env = await createTestProjectEnvironment({
      "package.json": "{\"type\":\"module\"}",
      "src/refund.ts": "export class RefundService {}\n",
    });

    try {
      await env.indexCoordinator.indexProject(env.projectRootPath, "full");
      const worker = (env.searchService as unknown as {
        sqliteSearchWorker: { searchCandidates: () => Promise<never> };
      }).sqliteSearchWorker;
      let calls = 0;
      worker.searchCandidates = async () => {
        calls += 1;
        throw failure.create();
      };

      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(
          env.searchService.search(env.projectRootPath, "RefundService", "lexical", 5, 0, undefined, "metadata"),
          (error: Error) => error instanceof AppError &&
            error.code === failure.code &&
            error.statusCode === 503 &&
            error.retryable,
        );
      }
      assert.equal(calls, 2, "retryable capacity failure was cached or reused after rejection");
      assert.equal(env.searchService.getCacheStats().totalEntries, 0);
    } finally {
      await env.cleanup();
    }
  });

  test(`structured SearchService clauses expose ${failure.code} as retryable 503`, async () => {
    const env = await createTestProjectEnvironment({
      "package.json": "{\"type\":\"module\"}",
      "src/refund.ts": "export class RefundService {}\n",
    });

    try {
      await env.indexCoordinator.indexProject(env.projectRootPath, "full");
      const worker = (env.searchService as unknown as {
        sqliteSearchWorker: { searchByTextSubstrings: () => Promise<never> };
      }).sqliteSearchWorker;
      let calls = 0;
      worker.searchByTextSubstrings = async () => {
        calls += 1;
        throw failure.create();
      };

      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(
          env.searchService.search(
            env.projectRootPath,
            'content:"RefundService"',
            "lexical",
            5,
            0,
            undefined,
            "metadata",
          ),
          (error: Error) => error instanceof AppError &&
            error.code === failure.code &&
            error.statusCode === 503 &&
            error.retryable,
        );
      }
      assert.equal(calls, 2);
      assert.equal(env.searchService.getCacheStats().totalEntries, 0);
    } finally {
      await env.cleanup();
    }
  });

  test(`nested structured SearchService clauses preserve ${failure.code}`, async () => {
    const env = await createTestProjectEnvironment({
      "package.json": "{\"type\":\"module\"}",
      "src/refund.ts": "export class RefundService {}\n",
    });

    try {
      await env.indexCoordinator.indexProject(env.projectRootPath, "full");
      const worker = (env.searchService as unknown as {
        sqliteSearchWorker: { searchCandidates: () => Promise<never> };
      }).sqliteSearchWorker;
      worker.searchCandidates = async () => {
        throw failure.create();
      };

      await assert.rejects(
        env.searchService.search(
          env.projectRootPath,
          "symbol:RefundService",
          "symbol",
          5,
          0,
          undefined,
          "metadata",
        ),
        (error: Error) => error instanceof AppError &&
          error.code === failure.code &&
          error.statusCode === 503 &&
          error.retryable,
      );
    } finally {
      await env.cleanup();
    }
  });

  test(`project routing exposes ${failure.code} as retryable 503`, async () => {
    const env = await createTestProjectEnvironment({});
    try {
      const worker = (env.searchService as unknown as {
        sqliteSearchWorker: { searchProjectRoutes: () => Promise<never> };
      }).sqliteSearchWorker;
      worker.searchProjectRoutes = async () => {
        throw failure.create();
      };

      await assert.rejects(
        env.searchService.searchProjectRouteMatches("RefundService", 10),
        (error: Error) => error instanceof AppError &&
          error.code === failure.code &&
          error.statusCode === 503 &&
          error.retryable,
      );
    } finally {
      await env.cleanup();
    }
  });
}

test("SearchService does not submit SQLite candidates after its search budget is exhausted", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/refund.ts": "export class RefundService {}\n",
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    const worker = (env.searchService as unknown as {
      sqliteSearchWorker: { searchCandidates: () => Promise<never> };
    }).sqliteSearchWorker;
    let calls = 0;
    worker.searchCandidates = async () => {
      calls += 1;
      throw new Error("candidate work must not be submitted");
    };
    const searchPlainQuery = (env.searchService as unknown as {
      searchPlainQuery: (...args: unknown[]) => Promise<unknown>;
    }).searchPlainQuery.bind(env.searchService);

    await searchPlainQuery(
      env.projectRootPath,
      "RefundService",
      "lexical",
      5,
      0,
      undefined,
      "metadata",
      { ftsMs: 0, symbolMs: 0, totalMs: 0, vectorMs: 0 },
    );
    assert.equal(calls, 0);
  } finally {
    await env.cleanup();
  }
});

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

test("structured SearchService queries yield the event loop while SQLite work is pending", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/refund.ts": "export class RefundService {}\n",
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
      'content:"RefundService"',
      "lexical",
      5,
      0,
      undefined,
      "metadata",
    );
    const timerFiredBeforeSearchResolved = timerFired;
    await timerPromise;

    assert.ok(response.results.length > 0);
    assert.equal(timerFiredBeforeSearchResolved, true);
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
