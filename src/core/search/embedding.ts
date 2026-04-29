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
 * 简单的内存嵌入实现
 * 使用 TF-IDF 风格的词频统计作为伪嵌入
 * 适用于没有外部依赖的场景
 */
export class InMemoryEmbeddingProvider implements EmbeddingProvider {
  private readonly dimension: number;
  private readonly modelName: string;

  constructor(dimension: number = 128, modelName: string = "in-memory-hash-vector-v1") {
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

  private bucketForToken(token: string): number {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return Math.abs(hash) % this.dimension;
  }

  private computeTfIdfVector(text: string): number[] {
    const tokens = this.tokenize(text);
    const tf: Map<string, number> = new Map();

    // 计算词频
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // 归一化并计算 TF-IDF
    const vector = new Array<number>(this.dimension).fill(0);
    for (const [token, freq] of tf) {
      const idx = this.bucketForToken(token);
      const tfNorm = freq / tokens.length;
      const tokenWeight = 1 + Math.log1p(token.length);
      vector[idx] += tfNorm * tokenWeight;
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
    // 简单的分词：处理驼峰、下划线、空白
    return text
      .replace(/([a-z])([A-Z])/g, "$1 $2") // 驼峰分割
      .replace(/[_\-./\\:#]/g, " ") // 分隔符替换
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  }
}

/**
 * 余弦相似度计算
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vector dimensions must match");
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

  // 排序并返回 topK
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
