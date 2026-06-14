import { readFile } from "node:fs/promises";

import { z } from "zod";

import { AppError } from "../common/errors.js";
import type { SearchQualityCaseInput, SearchQualityEvaluation } from "../common/types.js";
import type { IndexCoordinator } from "../indexing/indexCoordinator.js";
import type { SearchService } from "./searchService.js";

const SEARCH_FILTER_LANGUAGES = ["java", "javascript", "dotnet", "python", "markdown"] as const;
const SEARCH_MODES = ["auto", "lexical", "symbol", "semantic", "hybrid"] as const;

const evalCaseSchema = z.object({
  excludePathPrefix: z.string().min(1).optional(),
  expectedFiles: z.array(z.string().min(1)).optional(),
  expectedTopFile: z.string().min(1).optional(),
  languages: z.array(z.enum(SEARCH_FILTER_LANGUAGES)).min(1).optional(),
  mode: z.enum(SEARCH_MODES).default("auto"),
  name: z.string().min(1),
  pathContains: z.string().min(1).optional(),
  pathPrefix: z.string().min(1).optional(),
  query: z.string().min(1),
  topK: z.number().int().min(1).max(50).optional(),
});

const evalFileSchema = z.object({
  minPassRate: z.number().min(0).max(1).default(1),
  suites: z.array(
    z.object({
      cases: z.array(evalCaseSchema).min(1),
      projectRootPath: z.string().min(1),
    }),
  ).min(1),
});

export interface EvalSuite {
  cases: SearchQualityCaseInput[];
  projectRootPath: string;
}

export interface EvalConfig {
  minPassRate: number;
  suites: EvalSuite[];
}

export function parseEvalConfig(raw: string, sourcePath: string): EvalConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new AppError("EVAL_FILE_INVALID", `Eval case file is not valid JSON: ${sourcePath} (${(error as Error).message})`, { statusCode: 400 });
  }

  const parsed = evalFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new AppError("EVAL_FILE_INVALID", `Eval case file failed validation: ${sourcePath} (${issues})`, { statusCode: 400 });
  }

  return parsed.data;
}

export async function loadEvalConfig(filePath: string): Promise<EvalConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new AppError("EVAL_FILE_NOT_FOUND", `Cannot read eval case file: ${filePath} (${(error as Error).message})`, { statusCode: 404 });
  }
  return parseEvalConfig(raw, filePath);
}

export interface EvalRunResult {
  evaluations: SearchQualityEvaluation[];
  overallPassRate: number;
  passed: boolean;
  report: string;
}

export function summarizeEvaluations(evaluations: SearchQualityEvaluation[], minPassRate: number): EvalRunResult {
  const lines: string[] = [];
  let totalCases = 0;
  let totalPassed = 0;

  for (const evaluation of evaluations) {
    lines.push(`Project: ${evaluation.projectRootPath}`);
    for (const caseResult of evaluation.cases) {
      const status = caseResult.passed ? "PASS" : "FAIL";
      const rank = caseResult.firstRelevantRank !== undefined ? ` rank=${caseResult.firstRelevantRank}` : "";
      lines.push(`  [${status}] ${caseResult.name} (mode=${caseResult.mode}${rank})`);
      if (!caseResult.passed) {
        for (const reason of caseResult.reasons) {
          lines.push(`         - ${reason}`);
        }
        lines.push(`         - top files: ${caseResult.actualFiles.slice(0, 5).join(", ") || "(none)"}`);
      }
    }
    const { summary } = evaluation;
    lines.push(
      `  Summary: ${summary.passed}/${summary.total} passed`
      + ` | passRate=${summary.passRate.toFixed(2)}`
      + ` | top1=${summary.top1Recall.toFixed(2)}`
      + ` | top5=${summary.top5Recall.toFixed(2)}`
      + ` | MRR=${summary.meanReciprocalRank.toFixed(2)}`,
    );
    lines.push("");
    totalCases += summary.total;
    totalPassed += summary.passed;
  }

  const overallPassRate = totalCases === 0 ? 1 : totalPassed / totalCases;
  const passed = overallPassRate >= minPassRate;
  lines.push(`Overall: ${totalPassed}/${totalCases} passed (passRate=${overallPassRate.toFixed(2)}, required>=${minPassRate.toFixed(2)}) → ${passed ? "PASS" : "FAIL"}`);

  return { evaluations, overallPassRate, passed, report: lines.join("\n") };
}

export async function runEval(
  config: EvalConfig,
  indexCoordinator: IndexCoordinator,
  searchService: SearchService,
): Promise<EvalRunResult> {
  const evaluations: SearchQualityEvaluation[] = [];
  for (const suite of config.suites) {
    const indexResult = await indexCoordinator.ensureFreshIndex(suite.projectRootPath);
    const evaluation = await searchService.evaluateSearchQuality(indexResult.projectRootPath, suite.cases);
    evaluations.push(evaluation);
  }
  return summarizeEvaluations(evaluations, config.minPassRate);
}
