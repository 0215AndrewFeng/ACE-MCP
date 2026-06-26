import test from "node:test";
import assert from "node:assert/strict";

import { javascriptAdapter } from "./index.js";

test("javascript adapter extracts Vue script setup symbols and maps lines to the original SFC", () => {
  const analysis = javascriptAdapter.analyzeSource!(
    "file-checkout-vue",
    "src/Checkout.vue",
    [
      "<template>",
      "  <button @click=\"submitCheckout\">Pay</button>",
      "  <pre>function templateOnly() { return false }</pre>",
      "</template>",
      "",
      "<style>",
      "function styleOnly() { return false }",
      "</style>",
      "",
      "<script setup lang=\"ts\">",
      "import { discountService } from './discounts';",
      "",
      "function submitCheckout(orderId: string) {",
      "  return discountService.applyDiscount(orderId);",
      "}",
      "</script>",
      "",
    ].join("\n"),
  );

  const submit = analysis.symbols.find((symbol) => symbol.name === "submitCheckout");
  assert.equal(submit?.kind, "function");
  assert.equal(submit?.line, 13);
  assert.equal(submit?.modulePath, "src/Checkout");
  assert.equal(analysis.symbols.some((symbol) => symbol.name === "templateOnly"), false);
  assert.equal(analysis.symbols.some((symbol) => symbol.name === "styleOnly"), false);

  assert.ok(analysis.imports.some((entry) => entry.alias === "discountService" && entry.line === 11));
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "discountService.applyDiscount" &&
        usage.kind === "call" &&
        usage.line === 14 &&
        usage.ownerSymbol === "submitCheckout",
    ),
  );
});

test("javascript adapter extracts Vue template identifiers as usages without owners", () => {
  const analysis = javascriptAdapter.analyzeSource!(
    "file-checkout-template-vue",
    "src/Checkout.vue",
    [
      "<template>",
      "  <ProductCard :item=\"selectedItem\" @submit.stop=\"submitCheckout\" v-if=\"canCheckout && cart.total > 0\" />",
      "  <hamburger @toggleClick=\"submitCheckout\" />",
      "  <span>{{ formatCurrency(cart.total) }}</span>",
      "</template>",
      "",
      "<script setup lang=\"ts\">",
      "import ProductCard from './ProductCard.vue';",
      "",
      "const selectedItem = {};",
      "const canCheckout = true;",
      "const cart = { total: 10 };",
      "",
      "function submitCheckout() {",
      "  return cart.total;",
      "}",
      "",
      "function formatCurrency(value: number) {",
      "  return String(value);",
      "}",
      "</script>",
      "",
    ].join("\n"),
  );

  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "ProductCard" &&
        usage.kind === "usage" &&
        usage.line === 2 &&
        usage.ownerSymbol === undefined &&
        usage.candidateNames.includes("ProductCard"),
    ),
  );
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "submitCheckout" &&
        usage.kind === "usage" &&
        usage.line === 2 &&
        usage.ownerSymbol === undefined &&
        usage.candidateNames.includes("submitCheckout"),
    ),
  );
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "hamburger" &&
        usage.kind === "usage" &&
        usage.line === 3 &&
        usage.ownerSymbol === undefined &&
        usage.candidateNames.includes("Hamburger"),
    ),
  );
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "formatCurrency" &&
        usage.kind === "usage" &&
        usage.line === 4 &&
        usage.ownerSymbol === undefined &&
        usage.candidateNames.includes("formatCurrency"),
    ),
  );
});

test("javascript adapter extracts Svelte script symbols and maps lines to the original SFC", () => {
  const analysis = javascriptAdapter.analyzeSource!(
    "file-ledger-svelte",
    "src/LedgerPanel.svelte",
    [
      "<script lang=\"ts\">",
      "import { Ledger } from './ledger';",
      "",
      "export function submit(amount: number) {",
      "  const ledger = new Ledger();",
      "  return ledger.post(amount);",
      "}",
      "</script>",
      "",
      "<pre>function markupOnly() { return false }</pre>",
      "<button>Submit</button>",
      "",
    ].join("\n"),
  );

  const submit = analysis.symbols.find((symbol) => symbol.name === "submit");
  assert.equal(submit?.kind, "function");
  assert.equal(submit?.line, 4);
  assert.equal(submit?.modulePath, "src/LedgerPanel");
  assert.equal(analysis.symbols.some((symbol) => symbol.name === "markupOnly"), false);

  assert.ok(analysis.imports.some((entry) => entry.alias === "Ledger" && entry.line === 2));
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "ledger.post" &&
        usage.kind === "call" &&
        usage.line === 6 &&
        usage.ownerSymbol === "submit",
    ),
  );
});

test("javascript adapter extracts Svelte markup identifiers as usages without owners", () => {
  const analysis = javascriptAdapter.analyzeSource!(
    "file-ledger-template-svelte",
    "src/LedgerPanel.svelte",
    [
      "<script lang=\"ts\">",
      "import LedgerButton from './LedgerButton.svelte';",
      "export let ledger = { amount: 0 };",
      "let canSubmit = true;",
      "function submitLedger() { return ledger.amount; }",
      "function formatAmount(value: number) { return String(value); }",
      "</script>",
      "",
      "<LedgerButton on:click={submitLedger} bind:value={ledger.amount} disabled={!canSubmit} />",
      "{#if canSubmit}",
      "  <p>{formatAmount(ledger.amount)}</p>",
      "{/if}",
      "",
    ].join("\n"),
  );

  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "LedgerButton" &&
        usage.kind === "usage" &&
        usage.line === 9 &&
        usage.ownerSymbol === undefined &&
        usage.candidateNames.includes("LedgerButton"),
    ),
  );
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "submitLedger" &&
        usage.kind === "usage" &&
        usage.line === 9 &&
        usage.ownerSymbol === undefined &&
        usage.candidateNames.includes("submitLedger"),
    ),
  );
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "formatAmount" &&
        usage.kind === "usage" &&
        usage.line === 11 &&
        usage.ownerSymbol === undefined &&
        usage.candidateNames.includes("formatAmount"),
    ),
  );
});
