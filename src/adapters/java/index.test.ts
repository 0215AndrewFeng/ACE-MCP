import test from "node:test";
import assert from "node:assert/strict";

import { javaAdapter } from "./index.js";

test("java adapter extracts Spring annotations and HTTP mapping paths as usages", () => {
  const analysis = javaAdapter.analyzeSource!(
    "RefundController.java",
    "src/main/java/com/acme/RefundController.java",
    [
      "package com.acme;",
      "",
      "import org.springframework.web.bind.annotation.PostMapping;",
      "import org.springframework.web.bind.annotation.RequestMapping;",
      "import org.springframework.web.bind.annotation.RestController;",
      "",
      "@RestController",
      "@RequestMapping(\"/api/refund\")",
      "public class RefundController {",
      "  @PostMapping(\"/apply\")",
      "  public String applyRefund() {",
      "    return \"ok\";",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  assert.ok(analysis.usages.some((usage) => usage.rawName === "@RestController"));
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "/api/refund" &&
        usage.candidateNames.includes("/api/refund") &&
        usage.ownerSymbol === "com.acme.RefundController",
    ),
  );
  assert.ok(
    analysis.usages.some(
      (usage) =>
        usage.rawName === "/apply" &&
        usage.candidateNames.includes("/api/refund/apply") &&
        usage.ownerSymbol === "com.acme.RefundController.applyRefund",
    ),
  );
});
