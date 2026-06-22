import test from "node:test";
import assert from "node:assert/strict";

import type { EmbeddingProvider } from "./embedding.js";
import { RemoteEmbeddingProvider } from "./remoteEmbedding.js";

function fallbackProvider(): EmbeddingProvider {
  return {
    clearQueryCache() {},
    async embed(text: string) {
      return [text.length];
    },
    async embedBatch(texts: string[]) {
      return texts.map((text) => [text.length]);
    },
    async embedQuery(query: string) {
      return [query.length];
    },
    getDimension() {
      return 1;
    },
    getModelName() {
      return "fallback";
    },
    getQueryCacheStats() {
      return { hits: 0, misses: 0, size: 0 };
    },
  };
}

test("RemoteEmbeddingProvider sorts API embeddings by response index and updates dimension", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      { embedding: [0, 2], index: 1 },
      { embedding: [1, 0], index: 0 },
    ],
    model: "test",
    usage: { prompt_tokens: 1, total_tokens: 1 },
  }), { status: 200 });

  try {
    const provider = new RemoteEmbeddingProvider("https://example.test/embeddings", "key", "model");
    const embeddings = await provider.embedBatch(["a", "b"]);

    assert.deepEqual(embeddings, [[1, 0], [0, 2]]);
    assert.equal(provider.getDimension(), 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RemoteEmbeddingProvider falls back on API failures and caches query embeddings", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("nope", { status: 500 });
  };

  try {
    const provider = new RemoteEmbeddingProvider("https://example.test/embeddings", "key", "model", fallbackProvider());
    assert.deepEqual(await provider.embedQuery("refund"), [6]);
    assert.deepEqual(await provider.embedQuery("refund"), [6]);
    assert.deepEqual(provider.getQueryCacheStats(), { hits: 1, misses: 1, size: 1 });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
