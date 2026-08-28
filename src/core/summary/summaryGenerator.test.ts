import assert from "node:assert/strict";
import test from "node:test";

import { createTestProjectEnvironment } from "../../test/helpers.js";
import type { LlmCompletionOptions } from "../llm/llmClient.js";
import { SummaryGenerator } from "./summaryGenerator.js";

test("SummaryGenerator reuses unchanged modules unless forced and records key symbols", async () => {
  const env = await createTestProjectEnvironment({
    "src/refund.ts": "export class RefundService {\n  refundOrder(): boolean { return true; }\n}\n",
  });
  const prompts: string[] = [];
  const llmClient = {
    isConfigured: () => true,
    complete: async (options: LlmCompletionOptions) => {
      prompts.push(options.messages.at(-1)?.content ?? "");
      return {
        content: prompts.length % 2 === 0 ? "Project architecture." : "Refund module.",
        usage: { completionTokens: 2, promptTokens: 3 },
      };
    },
  };
  const generator = new SummaryGenerator(
    env.store,
    llmClient as never,
    { debug() {}, info() {}, warn() {} } as never,
  );

  try {
    const indexResult = await env.indexCoordinator.indexProject(env.projectRootPath, "full");
    const first = await generator.generateProjectSummary(env.projectRootPath, indexResult.projectId);
    const firstCallCount = prompts.length;
    const firstSummary = await generator.loadSummary(env.projectRootPath);

    assert.equal(first.regeneratedModules, 1);
    assert.equal(first.cachedModules, 0);
    assert.ok(firstSummary?.modules[0]?.keySymbols.includes("RefundService"));
    assert.match(prompts[0] ?? "", /Key symbols \([1-9][0-9]*\):/);

    const cached = await generator.generateProjectSummary(env.projectRootPath, indexResult.projectId);
    assert.equal(cached.regeneratedModules, 0);
    assert.equal(cached.cachedModules, 1);
    assert.equal(prompts.length, firstCallCount);

    const forced = await generator.generateProjectSummary(env.projectRootPath, indexResult.projectId, { force: true });
    assert.equal(forced.regeneratedModules, 1);
    assert.equal(forced.cachedModules, 0);
    assert.equal(forced.forced, true);
    assert.equal(prompts.length, firstCallCount + 2);
  } finally {
    await env.cleanup();
  }
});
