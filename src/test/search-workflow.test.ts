import test from "node:test";
import assert from "node:assert/strict";

import { createTestProjectEnvironment } from "./helpers.js";

test("index and search workflow finds text, definitions, references, and call graph edges", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/orderController.ts": [
      "import { RefundService } from './refundService';",
      "export function handleRefund() {",
      "  const service = new RefundService();",
      "  return service.refundOrder('order-1');",
      "}",
      "",
    ].join("\n"),
    "src/refundService.ts": [
      "export class RefundService {",
      "  refundOrder(orderId: string) {",
      "    return `refund ${orderId}`;",
      "  }",
      "}",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const search = await env.searchService.search(env.projectRootPath, "refundOrder", "auto", 5);
    assert.ok(search.results.some((result) => result.filePath === "src/refundService.ts"));

    const definitions = await env.searchService.findDefinitions(env.projectRootPath, "RefundService.refundOrder", 5);
    assert.equal(definitions.results[0]?.filePath, "src/refundService.ts");

    const references = await env.searchService.findReferences(env.projectRootPath, "RefundService.refundOrder", 5);
    assert.ok(references.results.some((result) => result.filePath === "src/orderController.ts"));

    const callers = await env.searchService.findCallers(env.projectRootPath, "RefundService.refundOrder", 5);
    assert.ok(callers.results.some((result) => result.ownerSymbol === "handleRefund"));
  } finally {
    await env.cleanup();
  }
});

test("javascript call graph resolves imported exported instance methods by exported variable type", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/checkout.ts": [
      "import { discountService } from './discounts';",
      "",
      "export function checkout(orderId: string) {",
      "  return discountService.applyDiscount(orderId);",
      "}",
      "",
    ].join("\n"),
    "src/discounts.ts": [
      "export class AuditDiscounts {",
      "  applyDiscount(orderId: string) {",
      "    return `audit ${orderId}`;",
      "  }",
      "}",
      "",
      "export class DiscountService {",
      "  applyDiscount(orderId: string) {",
      "    return `discount ${orderId}`;",
      "  }",
      "}",
      "",
      "export const discountService = new DiscountService();",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const callers = await env.searchService.findCallers(env.projectRootPath, "DiscountService.applyDiscount", 5);
    assert.ok(callers.results.some((result) => result.ownerSymbol === "checkout"));

    const auditCallers = await env.searchService.findCallers(env.projectRootPath, "AuditDiscounts.applyDiscount", 5);
    assert.ok(!auditCallers.results.some((result) => result.ownerSymbol === "checkout"));
  } finally {
    await env.cleanup();
  }
});

test("python call graph behavior remains scoped to existing variable type inference", async () => {
  const env = await createTestProjectEnvironment({
    "src/workflow.py": [
      "class Ledger:",
      "    def post(self, amount):",
      "        return amount",
      "",
      "def submit(amount):",
      "    ledger = Ledger()",
      "    return ledger.post(amount)",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const callers = await env.searchService.findCallers(env.projectRootPath, "Ledger.post", 5);
    assert.ok(callers.results.some((result) => result.ownerSymbol === "submit"));
  } finally {
    await env.cleanup();
  }
});

test("markdown headings are searchable section definitions and fenced code identifiers resolve as references", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "docs/refund.md": [
      "# Refund Guide",
      "",
      "## RefundService refundOrder",
      "",
      "Use the service directly in examples:",
      "",
      "```ts",
      "const service = new RefundService();",
      "service.refundOrder('order-1');",
      "```",
      "",
    ].join("\n"),
    "src/refundService.ts": [
      "export class RefundService {",
      "  refundOrder(orderId: string) {",
      "    return `refund ${orderId}`;",
      "  }",
      "}",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const definitions = await env.searchService.findDefinitions(env.projectRootPath, "RefundService refundOrder", 5);
    assert.equal(definitions.results[0]?.filePath, "docs/refund.md");
    assert.equal(definitions.results[0]?.kind, "section");

    const references = await env.searchService.findReferences(env.projectRootPath, "RefundService.refundOrder", 5);
    assert.ok(references.results.some((result) => result.filePath === "docs/refund.md"));
  } finally {
    await env.cleanup();
  }
});

test("vue single-file component script participates in javascript call graph resolution", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/Checkout.vue": [
      "<template>",
      "  <button @click=\"checkout\">Checkout</button>",
      "</template>",
      "",
      "<script setup lang=\"ts\">",
      "import { discountService } from './discounts';",
      "",
      "function checkout(orderId: string) {",
      "  return discountService.applyDiscount(orderId);",
      "}",
      "</script>",
      "",
    ].join("\n"),
    "src/discounts.ts": [
      "export class DiscountService {",
      "  applyDiscount(orderId: string) {",
      "    return `discount ${orderId}`;",
      "  }",
      "}",
      "",
      "export const discountService = new DiscountService();",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const callers = await env.searchService.findCallers(env.projectRootPath, "DiscountService.applyDiscount", 5);
    const vueCaller = callers.results.find((result) => result.filePath === "src/Checkout.vue");
    assert.equal(vueCaller?.ownerSymbol, "checkout");
    assert.equal(vueCaller?.line, 9);
  } finally {
    await env.cleanup();
  }
});

test("svelte single-file component script participates in javascript call graph resolution", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/LedgerPanel.svelte": [
      "<script lang=\"ts\">",
      "import { Ledger } from './ledger';",
      "",
      "export function submit(amount: number) {",
      "  const ledger = new Ledger();",
      "  return ledger.post(amount);",
      "}",
      "</script>",
      "",
      "<button>Submit</button>",
      "",
    ].join("\n"),
    "src/ledger.ts": [
      "export class Ledger {",
      "  post(amount: number) {",
      "    return amount;",
      "  }",
      "}",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const callers = await env.searchService.findCallers(env.projectRootPath, "Ledger.post", 5);
    const svelteCaller = callers.results.find((result) => result.filePath === "src/LedgerPanel.svelte");
    assert.equal(svelteCaller?.ownerSymbol, "submit");
    assert.equal(svelteCaller?.line, 6);
  } finally {
    await env.cleanup();
  }
});
