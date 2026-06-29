import { AppError } from "../common/errors.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompletionOptions {
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  retries?: number;
  fallbackOnTimeout?: boolean;
  signal?: AbortSignal;
}

export interface LlmCompletionResult {
  content: string | null;
  usage: { promptTokens: number; completionTokens: number };
  fallback?: boolean;
  fallbackReason?: "timeout" | "error";
}

export interface LlmStreamChunk {
  type: "token" | "done" | "error";
  content?: string;
  usage?: { promptTokens: number; completionTokens: number };
  error?: string;
  isThinking?: boolean; // For DeepSeek reasoning_content
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface ChatCompletionStreamDelta {
  choices: Array<{
    delta: { content?: string };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function isRetryableLlmError(error: unknown): boolean {
  if ((error as Error).name === "AbortError") return true;
  if (error instanceof AppError) return error.retryable;
  return error instanceof Error;
}

export class LlmClient {
  private apiUrl_: string;
  private apiKey_: string;
  private model_: string;

  constructor(
    apiUrl: string,
    apiKey: string,
    model: string,
    private defaultMaxTokens: number = 2048,
    private defaultTemperature: number = 0.3,
  ) {
    this.apiUrl_ = apiUrl;
    this.apiKey_ = apiKey;
    this.model_ = model;
  }

  isConfigured(): boolean {
    return !!(this.apiUrl_ && this.apiKey_);
  }

  getConfig(): { apiUrl: string; model: string; configured: boolean } {
    return {
      apiUrl: this.apiUrl_,
      model: this.model_,
      configured: this.isConfigured(),
    };
  }

  getModelName(): string {
    return this.model_;
  }

  updateConfig(apiUrl: string, apiKey: string, model?: string): void {
    this.apiUrl_ = apiUrl;
    this.apiKey_ = apiKey;
    if (model) this.model_ = model;
  }

  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    if (!this.isConfigured()) {
      throw new AppError("LLM_NOT_CONFIGURED", "LLM API not configured. Set ACE_MCP_LLM_API_URL and ACE_MCP_LLM_API_KEY.", { statusCode: 400 });
    }

    const attempts = Math.max(1, Math.min(Math.floor(options.retries ?? 0), 5) + 1);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;

      if (options.signal) {
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      try {
        const response = await fetch(this.apiUrl_, {
          body: JSON.stringify({
            model: this.model_,
            messages: options.messages,
            max_tokens: options.maxTokens ?? this.defaultMaxTokens,
            temperature: options.temperature ?? this.defaultTemperature,
          }),
          headers: {
            Authorization: `Bearer ${this.apiKey_}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new AppError("LLM_API_ERROR", `LLM API returned ${response.status}: ${body.slice(0, 300)}`, { statusCode: 502, retryable: true });
        }

        const json = (await response.json()) as ChatCompletionResponse;

        const choice = json.choices?.[0];
        if (!choice?.message?.content) {
          throw new AppError("LLM_EMPTY_RESPONSE", "LLM API returned empty response", { statusCode: 502, retryable: true });
        }

        return {
          content: choice.message.content,
          usage: {
            promptTokens: json.usage?.prompt_tokens ?? 0,
            completionTokens: json.usage?.completion_tokens ?? 0,
          },
        };
      } catch (error) {
        lastError = error;
        if (attempt < attempts && isRetryableLlmError(error)) {
          continue;
        }
        if ((error as Error).name === "AbortError") {
          if (options.fallbackOnTimeout) {
            return {
              content: null,
              usage: { promptTokens: 0, completionTokens: 0 },
              fallback: true,
              fallbackReason: "timeout",
            };
          }
          throw new AppError("TIMEOUT", "LLM request timed out", { statusCode: 504, retryable: true });
        }
        if (options.fallbackOnTimeout) {
          return {
            content: null,
            usage: { promptTokens: 0, completionTokens: 0 },
            fallback: true,
            fallbackReason: "error",
          };
        }
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    throw lastError;
  }

  async *streamComplete(options: LlmCompletionOptions): AsyncGenerator<LlmStreamChunk> {
    if (!this.isConfigured()) {
      yield { type: "error", error: "LLM API not configured" };
      return;
    }

    const attempts = Math.max(1, Math.min(Math.floor(options.retries ?? 0), 5) + 1);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
      let emittedContent = false;

      if (options.signal) {
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      try {
        const response = await fetch(this.apiUrl_, {
          body: JSON.stringify({
            model: this.model_,
            messages: options.messages,
            max_tokens: options.maxTokens ?? this.defaultMaxTokens,
            temperature: options.temperature ?? this.defaultTemperature,
            stream: true,
          }),
          headers: {
            Authorization: `Bearer ${this.apiKey_}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new AppError("LLM_API_ERROR", `LLM API returned ${response.status}: ${body.slice(0, 300)}`, { statusCode: 502, retryable: true });
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new AppError("LLM_EMPTY_RESPONSE", "No response body", { statusCode: 502, retryable: true });
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let totalContent = "";
        let usage = { promptTokens: 0, completionTokens: 0 };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (!trimmed.startsWith("data: ")) continue;

            try {
              const json = JSON.parse(trimmed.slice(6)) as ChatCompletionStreamDelta;
              const delta = json.choices?.[0]?.delta;
              // Support both content and reasoning_content (DeepSeek thinking)
              const content = delta?.content;
              const reasoning = (delta as { reasoning_content?: string })?.reasoning_content;

              if (reasoning) {
                emittedContent = true;
                // Emit thinking content with special marker
                yield { type: "token", content: reasoning, isThinking: true };
              }
              if (content) {
                emittedContent = true;
                totalContent += content;
                yield { type: "token", content };
              }
              if (json.usage) {
                usage = {
                  promptTokens: json.usage.prompt_tokens ?? 0,
                  completionTokens: json.usage.completion_tokens ?? 0,
                };
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }

        // Estimate tokens if not provided by API
        if (usage.completionTokens === 0 && totalContent) {
          usage.completionTokens = Math.ceil(totalContent.length / 4);
        }

        yield { type: "done", content: totalContent, usage };
        return;
      } catch (error) {
        if (!emittedContent && attempt < attempts && isRetryableLlmError(error)) {
          continue;
        }
        if ((error as Error).name === "AbortError") {
          yield { type: "error", error: "LLM request timed out" };
        } else {
          yield { type: "error", error: (error as Error).message };
        }
        return;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
  }
}
