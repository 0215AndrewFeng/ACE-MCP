export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompletionOptions {
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmCompletionResult {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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

  updateConfig(apiUrl: string, apiKey: string, model?: string): void {
    this.apiUrl_ = apiUrl;
    this.apiKey_ = apiKey;
    if (model) this.model_ = model;
  }

  async complete(options: LlmCompletionOptions): Promise<LlmCompletionResult> {
    if (!this.isConfigured()) {
      throw new Error("LLM API not configured. Set ACE_MCP_LLM_API_URL and ACE_MCP_LLM_API_KEY.");
    }

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
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LLM API returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as ChatCompletionResponse;

    const choice = json.choices?.[0];
    if (!choice?.message?.content) {
      throw new Error("LLM API returned empty response");
    }

    return {
      content: choice.message.content,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }
}
