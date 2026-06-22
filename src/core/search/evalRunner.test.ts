import test from "node:test";
import assert from "node:assert/strict";

import { AppError } from "../common/errors.js";
import type { SearchQualityEvaluation } from "../common/types.js";
import { parseEvalConfig, runEval, summarizeEvaluations } from "./evalRunner.js";

function evaluation(passed: number, total: number): SearchQualityEvaluation {
  return {
    cases: [
      {
        actualFiles: passed > 0 ? ["src/a.ts"] : ["src/b.ts"],
        expectedFiles: ["src/a.ts"],
        firstRelevantRank: passed > 0 ? 1 : undefined,
        mode: "auto",
        name: "case",
        passed: passed > 0,
        query: "refund",
        reasons: passed > 0 ? [] : ["Missing expected file: src/a.ts"],
        topFile: passed > 0 ? "src/a.ts" : "src/b.ts",
      },
    ],
    projectRootPath: "/tmp/project",
    summary: {
      failed: total - passed,
      meanReciprocalRank: passed > 0 ? 1 : 0,
      passRate: total === 0 ? 1 : passed / total,
      passed,
      top1Recall: passed > 0 ? 1 : 0,
      top5Recall: passed > 0 ? 1 : 0,
      total,
    },
  };
}

test("parseEvalConfig validates suites and applies defaults", () => {
  const parsed = parseEvalConfig(JSON.stringify({
    suites: [
      {
        cases: [{ expectedFiles: ["src/a.ts"], name: "case", query: "refund" }],
        projectRootPath: "/tmp/project",
      },
    ],
  }), "cases.json");

  assert.equal(parsed.minPassRate, 1);
  assert.equal(parsed.suites[0].cases[0].mode, "auto");
});

test("parseEvalConfig wraps invalid JSON and schema errors as AppError", () => {
  assert.throws(() => parseEvalConfig("{bad", "cases.json"), (error) => error instanceof AppError && error.code === "EVAL_FILE_INVALID");
  assert.throws(() => parseEvalConfig(JSON.stringify({ suites: [] }), "cases.json"), /failed validation/);
});

test("summarizeEvaluations reports overall pass rate and failure details", () => {
  const summary = summarizeEvaluations([evaluation(0, 1)], 1);

  assert.equal(summary.passed, false);
  assert.equal(summary.overallPassRate, 0);
  assert.match(summary.report, /\[FAIL\] case/);
  assert.match(summary.report, /Overall: 0\/1 passed/);
});

test("runEval indexes each suite before evaluating search quality", async () => {
  const calls: string[] = [];
  const result = await runEval({
    minPassRate: 1,
    suites: [{ cases: [{ name: "case", query: "refund" }], projectRootPath: "/tmp/project" }],
  }, {
    async ensureFreshIndex(projectRootPath: string) {
      calls.push(`index:${projectRootPath}`);
      return { projectRootPath };
    },
  } as never, {
    async evaluateSearchQuality(projectRootPath: string) {
      calls.push(`eval:${projectRootPath}`);
      return evaluation(1, 1);
    },
  } as never);

  assert.deepEqual(calls, ["index:/tmp/project", "eval:/tmp/project"]);
  assert.equal(result.passed, true);
});
