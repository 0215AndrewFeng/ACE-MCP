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
  private dimension: number;
  private modelName: string;
  private vocabulary: Map<string, number> = new Map();
  private idf: Map<string, number> = new Map();
  private documentCount: number = 0;

  constructor(dimension: number = 128, modelName: string = "in-memory-tfidf") {
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
    // 学习词汇和 IDF（如果尚未学习）
    if (this.documentCount === 0) {
      this.learnVocabulary(texts);
    }

    // 为每个文本生成向量
    return texts.map((text) => this.computeTfIdfVector(text));
  }

  private learnVocabulary(texts: string[]): void {
    const docFreq: Map<string, number> = new Map();
    const allTokens: Set<string> = new Set();

    for (const text of texts) {
      const tokens = this.tokenize(text);
      const uniqueTokens = new Set(tokens);

      for (const token of uniqueTokens) {
        allTokens.add(token);
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }

    // 选择最常见的词作为词汇表
    const sortedTokens = [...allTokens].sort((a, b) => {
      const freqA = docFreq.get(a) || 0;
      const freqB = docFreq.get(b) || 0;
      return freqB - freqA;
    });

    // 限制词汇表大小
    const maxVocab = Math.min(this.dimension, sortedTokens.length);
    for (let i = 0; i < maxVocab; i++) {
      this.vocabulary.set(sortedTokens[i], i);
    }

    // 计算 IDF
    this.documentCount = texts.length;
    for (const [token, freq] of docFreq) {
      this.idf.set(token, Math.log((this.documentCount + 1) / (freq + 1)) + 1);
    }
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
      const idx = this.vocabulary.get(token);
      if (idx !== undefined) {
        const tfNorm = freq / tokens.length;
        const idf = this.idf.get(token) || 1;
        vector[idx] = tfNorm * idf;
      }
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
