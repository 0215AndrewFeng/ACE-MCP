import test from "node:test";
import assert from "node:assert/strict";

import { markdownAdapter } from "./index.js";

test("markdown adapter extracts headings as section symbols", () => {
  const analysis = markdownAdapter.analyzeSource!(
    "file-docs-api",
    "docs/api.md",
    [
      "# API Guide",
      "",
      "Intro text.",
      "",
      "## RefundService refundOrder",
      "",
      "Refund behavior details.",
      "",
      "### Retry Policy",
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    analysis.symbols.map((symbol) => ({
      containerName: symbol.containerName,
      fullName: symbol.fullName,
      kind: symbol.kind,
      line: symbol.line,
      modulePath: symbol.modulePath,
      name: symbol.name,
      signature: symbol.signature,
    })),
    [
      {
        containerName: undefined,
        fullName: "API Guide",
        kind: "section",
        line: 1,
        modulePath: "docs/api",
        name: "API Guide",
        signature: "# API Guide",
      },
      {
        containerName: "API Guide",
        fullName: "API Guide.RefundService refundOrder",
        kind: "section",
        line: 5,
        modulePath: "docs/api",
        name: "RefundService refundOrder",
        signature: "## RefundService refundOrder",
      },
      {
        containerName: "RefundService refundOrder",
        fullName: "API Guide.RefundService refundOrder.Retry Policy",
        kind: "section",
        line: 9,
        modulePath: "docs/api",
        name: "Retry Policy",
        signature: "### Retry Policy",
      },
    ],
  );
});

test("markdown adapter extracts fenced code identifiers as usages without treating fenced headings as sections", () => {
  const analysis = markdownAdapter.analyzeSource!(
    "file-docs-refund",
    "docs/refund.md",
    [
      "# Refund Guide",
      "",
      "```ts",
      "const service = new RefundService();",
      "service.refundOrder('order-1');",
      "# Not a Markdown Heading",
      "```",
      "",
    ].join("\n"),
  );

  assert.deepEqual(analysis.symbols.map((symbol) => symbol.name), ["Refund Guide"]);
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "RefundService" &&
        usage.kind === "usage" &&
        usage.line === 4 &&
        usage.candidateNames.includes("RefundService"),
    ),
  );
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "service.refundOrder" &&
        usage.kind === "usage" &&
        usage.line === 5 &&
        usage.candidateNames.includes("refundOrder"),
    ),
  );
});
