import type { Express, Request, Response } from "express";

import { normalizeAbsolutePath } from "../../core/project/pathNormalizer.js";
import { buildEnvelope } from "../../server/tools/responseEnvelope.js";
import type { WebAppDependencies } from "../types.js";

interface ProjectProfileSuggestion {
  code: "RUN_FULL_INDEX" | "GENERATE_SUMMARY" | "WARM_VECTOR_INDEX" | "REINDEX_FOR_SYMBOLS" | "REVIEW_FAILED_FILES";
  label: string;
  severity: "info" | "warning";
}

function buildSuggestions(input: {
  failedFileCount: number;
  indexed: boolean;
  missingVectorCount: number;
  summaryFound: boolean;
  symbolCount: number;
}): ProjectProfileSuggestion[] {
  if (!input.indexed) {
    return [
      {
        code: "RUN_FULL_INDEX",
        label: "先执行一次全量索引，建立文件、代码块和符号数据。",
        severity: "warning",
      },
    ];
  }

  const suggestions: ProjectProfileSuggestion[] = [];
  if (!input.summaryFound) {
    suggestions.push({
      code: "GENERATE_SUMMARY",
      label: "生成项目摘要，让问答能带上架构背景。",
      severity: "info",
    });
  }
  if (input.missingVectorCount > 0) {
    suggestions.push({
      code: "WARM_VECTOR_INDEX",
      label: "预热向量索引，提升语义搜索首查速度。",
      severity: "info",
    });
  }
  if (input.symbolCount === 0) {
    suggestions.push({
      code: "REINDEX_FOR_SYMBOLS",
      label: "符号数量为 0，建议检查语言识别后重新索引。",
      severity: "warning",
    });
  }
  if (input.failedFileCount > 0) {
    suggestions.push({
      code: "REVIEW_FAILED_FILES",
      label: "最近索引存在失败文件，建议查看失败列表并修复后重建。",
      severity: "warning",
    });
  }

  return suggestions;
}

export function registerProjectProfileRoutes(app: Express, dependencies: WebAppDependencies): void {
  app.get("/api/project-profile", async (req: Request, res: Response) => {
    const projectRootPath = String(req.query.projectRootPath ?? "").trim();
    if (!projectRootPath) {
      res.status(400).json({ error: "projectRootPath is required", code: "VALIDATION_ERROR" });
      return;
    }

    try {
      const normalized = normalizeAbsolutePath(projectRootPath);
      const projectRecord = dependencies.store.getProjectByRoot(normalized);
      const stats = dependencies.store.getProjectStats(normalized);
      const summary = await dependencies.summaryGenerator.loadSummary(normalized);
      const modelName = dependencies.embeddingProvider.getModelName();
      const vectorCoverage = projectRecord
        ? dependencies.store.getVectorCoverage(projectRecord.project_id, modelName)
        : { indexedChunkCount: 0, missingChunkCount: 0, totalChunkCount: 0 };
      const hasVectorIndex = projectRecord ? dependencies.store.hasVectorIndex(projectRecord.project_id, modelName) : false;
      const files = projectRecord ? dependencies.store.listProjectFiles(projectRecord.project_id) : [];
      const languageCounts = new Map<string, { fileCount: number; lineCount: number }>();
      for (const file of files) {
        const item = languageCounts.get(file.language) ?? { fileCount: 0, lineCount: 0 };
        item.fileCount += 1;
        item.lineCount += file.lineCount;
        languageCounts.set(file.language, item);
      }
      const languages = [...languageCounts.entries()]
        .map(([language, counts]) => ({ language, ...counts }))
        .sort((left, right) => right.fileCount - left.fileCount || left.language.localeCompare(right.language));
      const failedFileCount = stats?.latestIndexEvent?.failedFileCount ?? 0;
      const suggestions = buildSuggestions({
        failedFileCount,
        indexed: stats !== null,
        missingVectorCount: vectorCoverage.missingChunkCount,
        summaryFound: summary !== null,
        symbolCount: stats?.symbolCount ?? 0,
      });
      const status = stats === null
        ? "not_indexed"
        : suggestions.some((suggestion) => suggestion.severity === "warning")
          ? "needs_attention"
          : "healthy";

      res.json(
        buildEnvelope(
          { projectRootPath: normalized },
          {
            counts: {
              chunkCount: stats?.chunkCount ?? 0,
              fileCount: stats?.fileCount ?? 0,
              symbolCount: stats?.symbolCount ?? 0,
            },
            diagnostics: {
              status,
              suggestions,
            },
            indexed: stats !== null,
            languages,
            latestIndexing: stats?.latestIndexEvent ?? null,
            projectId: projectRecord?.project_id ?? null,
            projectRootPath: normalized,
            status: stats?.status ?? "unknown",
            summary: {
              found: summary !== null,
              generatedAt: summary?.generatedAt ?? null,
              moduleCount: summary?.modules.length ?? 0,
              tokenCount: summary ? summary.tokensUsed.prompt + summary.tokensUsed.completion : 0,
            },
            timestamps: {
              lastIndexAt: stats?.lastIndexAt ?? null,
              lastScanAt: stats?.lastScanAt ?? null,
            },
            vector: {
              coverage: {
                ...vectorCoverage,
                coverageRatio: vectorCoverage.totalChunkCount > 0
                  ? vectorCoverage.indexedChunkCount / vectorCoverage.totalChunkCount
                  : 0,
              },
              enabled: dependencies.settings.enableVectorSearch,
              hasIndex: hasVectorIndex,
              mode: dependencies.settings.vectorIndexingMode,
              modelName,
            },
          },
          {
            project: {
              chunkCount: stats?.chunkCount ?? 0,
              fileCount: stats?.fileCount ?? 0,
              status: stats?.status ?? "unknown",
              symbolCount: stats?.symbolCount ?? 0,
            },
            summary: {
              found: summary !== null,
              moduleCount: summary?.modules.length ?? 0,
            },
            vector: {
              ...vectorCoverage,
              hasIndex: hasVectorIndex,
              modelName,
            },
          },
          stats ? [] : ["Project has not been indexed yet."],
        ),
      );
    } catch (error: unknown) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: "INTERNAL_ERROR" });
    }
  });
}
