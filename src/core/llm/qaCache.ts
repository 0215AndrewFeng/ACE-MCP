/**
 * v4.3.0: LLM Response Cache
 * Caches QA responses based on question + sources hash
 * TTL: 5 minutes (300,000 ms)
 */

import { createHash } from "node:crypto";

export interface QaCacheEntry {
  answer: string;
  usage: { promptTokens: number; completionTokens: number };
  timestamp: number;
}

export class QaCache {
  private cache = new Map<string, QaCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs: number = 300_000, maxSize: number = 100) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  /**
   * Generate cache key from question and sources
   */
  private generateKey(question: string, sourceHashes: string[]): string {
    const content = `${question.trim().toLowerCase()}|${sourceHashes.sort().join(",")}`;
    return createHash("sha256").update(content).digest("hex").slice(0, 32);
  }

  /**
   * Generate hash for a source snippet
   */
  static hashSource(filePath: string, startLine: number, endLine: number, contentSnippet?: string): string {
    const base = `${filePath}:${startLine}-${endLine}`;
    const content = contentSnippet ? `${base}:${contentSnippet.slice(0, 512)}` : base;
    return createHash("md5").update(content).digest("hex").slice(0, 8);
  }

  /**
   * Get cached response if exists and not expired
   */
  get(question: string, sourceHashes: string[]): QaCacheEntry | null {
    const key = this.generateKey(question, sourceHashes);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  /**
   * Store response in cache
   */
  set(question: string, sourceHashes: string[], answer: string, usage: { promptTokens: number; completionTokens: number }): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const key = this.generateKey(question, sourceHashes);
    this.cache.set(key, {
      answer,
      usage,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; maxSize: number; ttlMs: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
    };
  }
}

// Singleton instance
export const qaCache = new QaCache();
