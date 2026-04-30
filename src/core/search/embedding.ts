/**
 * 轻量级向量嵌入接口
 * 当前使用内存向量索引，后续可按需升级到 sqlite-vss 或远程 API
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  getDimension(): number;
  getModelName(): string;
}

/**
 * 内存嵌入实现 v2
 * 使用双重 hash + n-gram 减少碰撞，提升向量区分度
 */
export class InMemoryEmbeddingProvider implements EmbeddingProvider {
  private readonly dimension: number;
  private readonly modelName: string;

  constructor(dimension: number = 256, modelName: string = "in-memory-hash-vector-v2") {
    this.dimension = dimension;
    this.modelName = modelName;
  }

  getDimension(): number {
    return this.dimension;
  }

  getModelName(): string {
    return this.modelName;
  }

  async embed(text: string): Promise<number[]> {
    return this.embedBatch([text]).then((results) => results[0]);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.computeTfIdfVector(text));
  }

  private fnv1aHash(input: string): number {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash;
  }

  private computeTfIdfVector(text: string): number[] {
    const tokens = this.tokenize(text);
    const tf: Map<string, number> = new Map();

    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    const vector = new Array<number>(this.dimension).fill(0);
    for (const [token, freq] of tf) {
      const tfNorm = freq / tokens.length;
      const tokenWeight = 1 + Math.log1p(token.length);

      // 双重 hash：在两个维度上分布权重，减少碰撞
      const idx1 = Math.abs(this.fnv1aHash(token)) % this.dimension;
      const idx2 = Math.abs(this.fnv1aHash(token + "_salt")) % this.dimension;
      vector[idx1] += tfNorm * tokenWeight * 0.6;
      vector[idx2] += tfNorm * tokenWeight * 0.4;
    }

    // L2 归一化
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  private tokenize(text: string): string[] {
    const words = text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_\-./\\:#]/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2);

    // 添加 bigram 特征提升局部顺序感知
    const bigrams: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.push(`${words[i]}_${words[i + 1]}`);
    }

    return [...words, ...bigrams];
  }
}

/**
 * 余弦相似度计算
 */
export function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * 在向量数组中搜索最相似的 k 个
 */
export function searchVectors(
  queryEmbedding: number[],
  vectors: Array<{ id: string; embedding: number[] }>,
  topK: number,
): Array<{ id: string; score: number }> {
  const scored = vectors.map((v) => ({
    id: v.id,
    score: cosineSimilarity(queryEmbedding, v.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
