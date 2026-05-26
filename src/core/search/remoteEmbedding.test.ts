import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import type { EmbeddingProvider } from "./embedding.js";
import { RemoteEmbeddingProvider } from "./remoteEmbedding.js";

let originalFetch: typeof fetch;

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
) {
  mock.method(globalThis, "fetch", (url: string | URL, init?: RequestInit) => {
    return handler(url.toString(), init ?? {});
  });
}

function makeJsonResponse(data: unknown, status = 200): Response {
  return {
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(data),
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response;
}

test("RemoteEmbeddingProvider", async (t) => {
  let provider: RemoteEmbeddingProvider;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    mock.restoreAll();
  });

  await t.test("getModelName returns configured model", () => {
    provider = new RemoteEmbeddingProvider(
      "https://api.example.com/v1/embeddings",
      "sk-test",
      "text-embedding-3-large",
    );
    assert.equal(provider.getModelName(), "text-embedding-3-large");
  });

  await t.test("getDimension returns 1536 before first request", () => {
    provider = new RemoteEmbeddingProvider(
      "https://api.example.com/v1/embeddings",
      "sk-test",
    );
    assert.equal(provider.getDimension(), 1536);
  });

  await t.test("embedBatch sends correct request and returns embeddings", async () => {
    mockFetch(async (url, init) => {
      assert.equal(url, "https://api.example.com/v1/embeddings");
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        "Bearer sk-test",
      );
      assert.equal(
        (init.headers as Record<string, string>)["Content-Type"],
        "application/json",
      );

      const body = JSON.parse(init.body as string);
      assert.equal(body.model, "text-embedding-3-small");
      assert.deepEqual(body.input, ["hello", "world"]);

      return makeJsonResponse({
        data: [
          { embedding: [0.1, 0.2, 0.3], index: 1 },
          { embedding: [0.4, 0.5, 0.6], index: 0 },
        ],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 2, total_tokens: 2 },
      });
    });

    provider = new RemoteEmbeddingProvider(
      "https://api.example.com/v1/embeddings",
      "sk-test",
    );
    const results = await provider.embedBatch(["hello", "world"]);

    assert.equal(results.length, 2);
    assert.deepEqual(results[0], [0.4, 0.5, 0.6]);
    assert.deepEqual(results[1], [0.1, 0.2, 0.3]);
  });

  await t.test("caches dimension after first successful request", async () => {
    mockFetch(async () =>
      makeJsonResponse({
        data: [{ embedding: new Array(512).fill(0), index: 0 }],
        model: "test-model",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    );

    provider = new RemoteEmbeddingProvider(
      "https://api.example.com/v1/embeddings",
      "sk-test",
    );
    assert.equal(provider.getDimension(), 1536);

    await provider.embed("test");
    assert.equal(provider.getDimension(), 512);
  });

  await t.test("falls back to fallback provider on HTTP error", async () => {
    mockFetch(async () => {
      throw new Error("connection refused");
    });

    const fallback: EmbeddingProvider = {
      async embed(_text: string): Promise<number[]> {
        return [0.9, 0.8, 0.7];
      },
      async embedBatch(texts: string[]): Promise<number[][]> {
        return texts.map(() => [0.9, 0.8, 0.7]);
      },
      async embedQuery(query: string): Promise<number[]> {
        return this.embed(query);
      },
      getDimension(): number {
        return 3;
      },
      getModelName(): string {
        return "test-fallback";
      },
      getQueryCacheStats() {
        return { size: 0, hits: 0, misses: 0 };
      },
      clearQueryCache() {},
    };

    provider = new RemoteEmbeddingProvider(
      "https://api.example.com/v1/embeddings",
      "sk-test",
      "text-embedding-3-small",
      fallback,
    );

    const results = await provider.embedBatch(["hello", "world"]);

    assert.equal(results.length, 2);
    assert.deepEqual(results[0], [0.9, 0.8, 0.7]);
    assert.deepEqual(results[1], [0.9, 0.8, 0.7]);
  });

  await t.test("falls back on non-2xx status", async () => {
    mockFetch(async () => makeJsonResponse({ error: "unauthorized" }, 401));

    const fallback: EmbeddingProvider = {
      async embed(_text: string): Promise<number[]> {
        return [1, 0, 0];
      },
      async embedBatch(texts: string[]): Promise<number[][]> {
        return texts.map(() => [1, 0, 0]);
      },
      async embedQuery(query: string): Promise<number[]> {
        return this.embed(query);
      },
      getDimension(): number {
        return 3;
      },
      getModelName(): string {
        return "test-fallback";
      },
      getQueryCacheStats() {
        return { size: 0, hits: 0, misses: 0 };
      },
      clearQueryCache() {},
    };

    provider = new RemoteEmbeddingProvider(
      "https://api.example.com/v1/embeddings",
      "sk-test",
      "text-embedding-3-small",
      fallback,
    );

    const results = await provider.embedBatch(["test"]);
    assert.deepEqual(results[0], [1, 0, 0]);
  });

  await t.test("throws when no fallback and request fails", async () => {
    mockFetch(async () => makeJsonResponse({ error: "server error" }, 500));

    provider = new RemoteEmbeddingProvider(
      "https://api.example.com/v1/embeddings",
      "sk-test",
    );

    await assert.rejects(() => provider.embedBatch(["test"]));
  });
});