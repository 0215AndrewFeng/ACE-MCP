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

test("java Spring annotations and interface methods surface controller entries and implementations", async () => {
  const env = await createTestProjectEnvironment({
    "pom.xml": "<project></project>",
    "src/main/java/com/acme/RefundController.java": [
      "package com.acme;",
      "",
      "import org.springframework.web.bind.annotation.PostMapping;",
      "import org.springframework.web.bind.annotation.RequestMapping;",
      "import org.springframework.web.bind.annotation.RestController;",
      "",
      "@RestController",
      "@RequestMapping(\"/api/refund\")",
      "public class RefundController {",
      "  private final RefundService refundService;",
      "",
      "  public RefundController(RefundService refundService) {",
      "    this.refundService = refundService;",
      "  }",
      "",
      "  @PostMapping(\"/apply\")",
      "  public String applyRefund() {",
      "    return refundService.submitRefund();",
      "  }",
      "}",
      "",
    ].join("\n"),
    "src/main/java/com/acme/RefundService.java": [
      "package com.acme;",
      "",
      "public interface RefundService {",
      "  String submitRefund();",
      "}",
      "",
    ].join("\n"),
    "src/main/java/com/acme/RefundServiceImpl.java": [
      "package com.acme;",
      "",
      "import org.springframework.stereotype.Service;",
      "",
      "@Service",
      "public class RefundServiceImpl implements RefundService {",
      "  @Override",
      "  public String submitRefund() {",
      "    return \"ok\";",
      "  }",
      "}",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const pathSearch = await env.searchService.search(env.projectRootPath, "/api/refund/apply", "auto", 5, 0, undefined, "metadata");
    assert.ok(pathSearch.results.some((result) => result.filePath === "src/main/java/com/acme/RefundController.java"));

    const implementationDefinitions = await env.searchService.findDefinitions(env.projectRootPath, "RefundService.submitRefund", 10, 0, undefined, "metadata");
    assert.ok(
      implementationDefinitions.results.some(
        (result) => result.filePath === "src/main/java/com/acme/RefundServiceImpl.java" && result.fullName === "com.acme.RefundServiceImpl.submitRefund",
      ),
    );

    const callers = await env.searchService.findCallers(env.projectRootPath, "RefundService.submitRefund", 10, 0, undefined, "metadata");
    assert.ok(callers.results.some((result) => result.ownerSymbol === "com.acme.RefundController.applyRefund"));
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

test("vue template usages resolve as references without call graph owners", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/Checkout.vue": [
      "<template>",
      "  <button @click=\"checkout\">Checkout</button>",
      "</template>",
      "",
      "<script setup lang=\"ts\">",
      "function checkout() {",
      "  return 'ok';",
      "}",
      "</script>",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const references = await env.searchService.findReferences(env.projectRootPath, "checkout", 10);
    assert.ok(
      references.results.some((result) => result.filePath === "src/Checkout.vue" && result.startLine === 2),
    );

    const callers = await env.searchService.findCallers(env.projectRootPath, "checkout", 10);
    assert.ok(!callers.results.some((result) => result.filePath === "src/Checkout.vue" && result.startLine === 2));
  } finally {
    await env.cleanup();
  }
});

test("vue Options API methods resolve template references without template caller edges", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/views/EndorseLookup.vue": [
      "<template>",
      "  <button @click=\"search\">Search</button>",
      "  <select @change=\"changeLanguage\"></select>",
      "</template>",
      "",
      "<script>",
      "export default {",
      "  name: 'EndorseLookup',",
      "  mounted() {",
      "    this.search();",
      "  },",
      "  methods: {",
      "    search() {",
      "      return this.changeLanguage();",
      "    },",
      "    changeLanguage() {",
      "      return 'zh-CN';",
      "    }",
      "  }",
      "};",
      "</script>",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const definitions = await env.searchService.findDefinitions(env.projectRootPath, "EndorseLookup.search", 10);
    assert.ok(
      definitions.results.some((result) => result.filePath === "src/views/EndorseLookup.vue" && result.line === 13),
    );

    const references = await env.searchService.findReferences(env.projectRootPath, "EndorseLookup.search", 10);
    assert.ok(
      references.results.some((result) => result.filePath === "src/views/EndorseLookup.vue" && result.startLine === 2),
    );

    const callers = await env.searchService.findCallers(env.projectRootPath, "EndorseLookup.search", 10);
    assert.ok(callers.results.some((result) => result.ownerSymbol === "EndorseLookup.mounted"));
    assert.ok(!callers.results.some((result) => result.filePath === "src/views/EndorseLookup.vue" && result.startLine === 2));
  } finally {
    await env.cleanup();
  }
});

test("vue Options API props and data fields resolve template references without caller edges", async () => {
  const env = await createTestProjectEnvironment({
    "package.json": "{\"type\":\"module\"}",
    "src/layout/components/Navbar.vue": [
      "<template>",
      "  <el-select v-model=\"currentLang\" @change=\"changeLanguage\">",
      "    <span>{{ avatar }}</span>",
      "  </el-select>",
      "</template>",
      "",
      "<script>",
      "export default {",
      "  name: 'Navbar',",
      "  props: {",
      "    avatar: String",
      "  },",
      "  data() {",
      "    return {",
      "      currentLang: 'zh-CN'",
      "    };",
      "  },",
      "  methods: {",
      "    changeLanguage(lang) {",
      "      this.currentLang = lang;",
      "    }",
      "  }",
      "};",
      "</script>",
      "",
    ].join("\n"),
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const currentLangDefinitions = await env.searchService.findDefinitions(env.projectRootPath, "Navbar.currentLang", 10);
    assert.ok(
      currentLangDefinitions.results.some((result) => result.filePath === "src/layout/components/Navbar.vue" && result.line === 15 && result.kind === "property"),
    );

    const avatarDefinitions = await env.searchService.findDefinitions(env.projectRootPath, "Navbar.avatar", 10);
    assert.ok(
      avatarDefinitions.results.some((result) => result.filePath === "src/layout/components/Navbar.vue" && result.line === 11 && result.kind === "property"),
    );

    const references = await env.searchService.findReferences(env.projectRootPath, "Navbar.currentLang", 10);
    assert.ok(
      references.results.some((result) => result.filePath === "src/layout/components/Navbar.vue" && result.startLine === 2),
    );

    const callers = await env.searchService.findCallers(env.projectRootPath, "Navbar.currentLang", 10);
    assert.ok(!callers.results.some((result) => result.filePath === "src/layout/components/Navbar.vue" && result.startLine === 2));
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
