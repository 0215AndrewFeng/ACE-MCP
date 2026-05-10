import { type EmbeddingProvider } from "./embedding.js";

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

export class RemoteEmbeddingProvider implements EmbeddingProvider {
  private dimension_?: number;
  private modelName_: string;

  constructor(
    private apiUrl: string,
    private apiKey: string,
    model: string = "text-embedding-3-small",
    private fallback?: EmbeddingProvider,
  ) {
    this.modelName_ = model;
  }

  getDimension(): number {
    return this.dimension_ ?? 1536;
  }

  getModelName(): string {
    return this.modelName_;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      const response = await fetch(this.apiUrl, {
        body: JSON.stringify({ input: texts, model: this.modelName_ }),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
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
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[RemoteEmbeddingProvider] request failed: ${message}, falling back to ${this.fallback?.getModelName() ?? "none"}`,
      );
      if (this.fallback) {
        return this.fallback.embedBatch(texts);
      }
      throw error;
    }
  }
}