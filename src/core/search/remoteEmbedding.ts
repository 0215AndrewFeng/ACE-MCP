import { type EmbeddingProvider } from "./embedding.js";
import type { Logger } from "../common/logger.js";

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

interface QueryCacheEntry {
  embedding: number[];
  timestamp: number;
}

export class RemoteEmbeddingProvider implements EmbeddingProvider {
  private dimension_?: number;
  private modelName_: string;
  private readonly queryCache = new Map<string, QueryCacheEntry>();
  private readonly queryCacheMaxSize = 1000;
  private readonly queryCacheTtlMs = 300_000; // 5 minutes
  private queryCacheHits = 0;
  private queryCacheMisses = 0;

  constructor(
    private apiUrl: string,
    private apiKey: string,
    model: string = "text-embedding-3-small",
    private fallback?: EmbeddingProvider,
    private logger?: Logger,
  ) {
    this.modelName_ = model;
  }

  getDimension(): number {
    return this.dimension_ ?? 1536;
  }

  getModelName(): string {
    return this.modelName_;
  }

  getQueryCacheStats(): { size: number; hits: number; misses: number } {
    return {
      size: this.queryCache.size,
      hits: this.queryCacheHits,
      misses: this.queryCacheMisses,
    };
  }

  clearQueryCache(): void {
    this.queryCache.clear();
    this.queryCacheHits = 0;
    this.queryCacheMisses = 0;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const results = await this.embedBatch([text], signal);
    return results[0];
  }

  async embedQuery(query: string, useCache = true): Promise<number[]> {
    if (useCache) {
      const cached = this.queryCache.get(query);
      if (cached && Date.now() - cached.timestamp < this.queryCacheTtlMs) {
        this.queryCacheHits++;
        return cached.embedding;
      }
    }

    this.queryCacheMisses++;
    const embedding = await this.embed(query);

    // Store in cache
    this.queryCache.set(query, { embedding, timestamp: Date.now() });
    this.evictQueryCache();

    return embedding;
  }

  private evictQueryCache(): void {
    if (this.queryCache.size <= this.queryCacheMaxSize) return;

    const now = Date.now();
    for (const [key, entry] of this.queryCache) {
      if (now - entry.timestamp > this.queryCacheTtlMs) {
        this.queryCache.delete(key);
      }
    }

    if (this.queryCache.size > this.queryCacheMaxSize) {
      const entries = [...this.queryCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, entries.length - this.queryCacheMaxSize);
      for (const [key] of toDelete) {
        this.queryCache.delete(key);
      }
    }
  }

  /**
   * v4.2.5: embedBatch now supports AbortSignal for cancellation
   */
  async embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    try {
      const response = await fetch(this.apiUrl, {
        body: JSON.stringify({ input: texts, model: this.modelName_ }),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Embedding API returned ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const json = (await response.json()) as EmbeddingResponse;

      if (json.data && json.data.length > 0 && !this.dimension_) {
        this.dimension_ = json.data[0].embedding.length;
      }

      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map((item) => item.embedding);
    } catch (error: unknown) {
      // v4.2.5: Distinguish between abort and other errors
      if (error instanceof Error && error.name === "AbortError") {
        this.logger?.warn("[RemoteEmbeddingProvider] request aborted");
        if (this.fallback) {
          return this.fallback.embedBatch(texts);
        }
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn(
        `[RemoteEmbeddingProvider] request failed: ${message}, falling back to ${this.fallback?.getModelName() ?? "none"}`,
      );
      if (this.fallback) {
        return this.fallback.embedBatch(texts);
      }
      throw error;
    }
  }
}