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
