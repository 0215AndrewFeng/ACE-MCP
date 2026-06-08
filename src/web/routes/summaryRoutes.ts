import type { Express, Request, Response } from "express";

import { AppError } from "../../core/common/errors.js";
import { normalizeAbsolutePath } from "../../core/project/pathNormalizer.js";
import { buildEnvelope } from "../../server/tools/responseEnvelope.js";
import type { WebAppDependencies } from "../types.js";

export function registerSummaryRoutes(app: Express, dependencies: WebAppDependencies): void {
  // ── Summary endpoints ─────────────────────────────────
  app.post("/api/summary/generate", async (req: Request, res: Response) => {
    try {
      const { projectRootPath } = req.body;
      const indexResult = await dependencies.indexCoordinator.ensureFreshIndex(String(projectRootPath ?? ""));
      const result = await dependencies.summaryGenerator.generateProjectSummary(indexResult.projectRootPath, indexResult.projectId);
      res.json(buildEnvelope(
        { projectRootPath: indexResult.projectRootPath },
        { outputDir: result.outputDir, filesWritten: result.filesWritten, moduleCount: result.moduleCount },
        { tokensUsed: result.tokensUsed, durationMs: result.durationMs },
        [],
      ));
    } catch (error: unknown) {
      const message = error instanceof AppError ? error.message : String(error);
      const status = error instanceof AppError ? error.statusCode : 500;
      res.status(status).json({ error: message, code: error instanceof AppError ? error.code : "UNKNOWN" });
    }
  });

  app.get("/api/summary", async (req: Request, res: Response) => {
    try {
      const projectRootPath = String(req.query.projectRootPath ?? "");
      const normalized = normalizeAbsolutePath(projectRootPath);
      const summary = await dependencies.summaryGenerator.loadSummary(normalized);
      if (!summary) {
        res.json({ found: false, note: "No summary found. Run generate_summary first." });
        return;
      }
      res.json({ found: true, ...summary });
    } catch (error: unknown) {
      res.status(500).json({ error: String(error) });
    }
  });
}
