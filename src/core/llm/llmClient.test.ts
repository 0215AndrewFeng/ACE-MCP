import test from "node:test";
import assert from "node:assert/strict";

import { LlmClient } from "./llmClient.js";

test("complete retries retryable LLM responses when retries is configured", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("temporary failure", { status: 502 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }));
  };

  try {
    const client = new LlmClient("https://example.test/chat", "key", "model");
    const result = await client.complete({
      messages: [{ role: "user", content: "hello" }],
      retries: 1,
    });

    assert.equal(result.content, "ok");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("complete does not retry unless retries is configured", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("temporary failure", { status: 502 });
  };

  try {
    const client = new LlmClient("https://example.test/chat", "key", "model");
    await assert.rejects(
      client.complete({ messages: [{ role: "user", content: "hello" }] }),
      /LLM API returned 502/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamComplete retries retryable LLM responses when retries is configured", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("temporary failure", { status: 502 });
    }
    return new Response([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"));
  };

  try {
    const client = new LlmClient("https://example.test/chat", "key", "model");
    const chunks = [];
    for await (const chunk of client.streamComplete({
      messages: [{ role: "user", content: "hello" }],
      retries: 1,
    })) {
      chunks.push(chunk);
    }

    assert.equal(calls, 2);
    assert.deepEqual(chunks.map(chunk => chunk.type), ["token", "done"]);
    assert.equal(chunks[0].content, "ok");
    assert.equal(chunks[1].content, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
