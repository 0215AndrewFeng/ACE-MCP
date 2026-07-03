import { existsSync } from "node:fs";

import type { ProjectListItem } from "../core/common/types.js";

export type DataHealthStatus = "ok" | "degraded" | "repairable";
export type DataHealthCheckSeverity = "info" | "warning" | "error";

export interface DataHealthCheck {
  code:
    | "PROJECT_FILES_UNAVAILABLE"
    | "PROJECT_LIST_UNAVAILABLE"
    | "PROJECT_PATH_MISSING"
    | "PROJECT_STATS_UNAVAILABLE"
    | "PROJECT_VECTOR_UNAVAILABLE";
  message: string;
  projectRootPath?: string;
  severity: DataHealthCheckSeverity;
}

export interface DataHealthSuggestion {
  code: "CHECK_PROJECT_PATH" | "RUN_DOCTOR" | "RUN_FULL_INDEX" | "WARM_VECTOR_INDEX";
  label: string;
  severity: "info" | "warning";
}

export interface DataHealthReport {
  checks: DataHealthCheck[];
  status: DataHealthStatus;
  suggestions: DataHealthSuggestion[];
}

export function buildDataHealthReport(checks: DataHealthCheck[]): DataHealthReport {
  const suggestions = dedupeSuggestions(checks.flatMap(suggestionsForCheck));
  return {
    checks,
    status: statusForChecks(checks),
    suggestions,
  };
}

export function buildProjectListDataHealth(projects: ProjectListItem[]): DataHealthReport {
  return buildDataHealthReport(projects
    .filter((project) => !existsSync(project.projectRootPath))
    .map((project) => ({
      code: "PROJECT_PATH_MISSING",
      message: "Registered project path no longer exists on disk.",
      projectRootPath: project.projectRootPath,
      severity: "warning",
    })));
}

export function unavailableDataHealthCheck(
  code: DataHealthCheck["code"],
  error: unknown,
  projectRootPath?: string,
): DataHealthCheck {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    projectRootPath,
    severity: code === "PROJECT_LIST_UNAVAILABLE" ? "error" : "warning",
  };
}

function dedupeSuggestions(suggestions: DataHealthSuggestion[]): DataHealthSuggestion[] {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    if (seen.has(suggestion.code)) return false;
    seen.add(suggestion.code);
    return true;
  });
}

function statusForChecks(checks: DataHealthCheck[]): DataHealthStatus {
  if (checks.length === 0) return "ok";
  if (checks.some((check) => check.code === "PROJECT_LIST_UNAVAILABLE")) return "degraded";
  return "repairable";
}

function suggestionsForCheck(check: DataHealthCheck): DataHealthSuggestion[] {
  switch (check.code) {
    case "PROJECT_FILES_UNAVAILABLE":
    case "PROJECT_STATS_UNAVAILABLE":
      return [{
        code: "RUN_FULL_INDEX",
        label: "重新执行全量索引以重建项目统计、文件和符号数据。",
        severity: "warning",
      }];
    case "PROJECT_LIST_UNAVAILABLE":
      return [{
        code: "RUN_DOCTOR",
        label: "运行 ace-mcp --doctor 检查本地数据库和目录权限。",
        severity: "warning",
      }];
    case "PROJECT_PATH_MISSING":
      return [{
        code: "CHECK_PROJECT_PATH",
        label: "检查项目目录是否被移动或删除，必要时重新添加并全量索引。",
        severity: "warning",
      }];
    case "PROJECT_VECTOR_UNAVAILABLE":
      return [{
        code: "WARM_VECTOR_INDEX",
        label: "预热向量索引或重新全量索引以恢复语义搜索缓存。",
        severity: "info",
      }];
  }
}
