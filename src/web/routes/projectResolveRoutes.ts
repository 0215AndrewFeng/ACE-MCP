import type { Express, Request, Response } from "express";

import { buildEnvelope } from "../../server/tools/responseEnvelope.js";
import { parseProjectResolveRequest } from "../requestValidation.js";
import type { WebAppDependencies } from "../types.js";

export function registerProjectResolveRoutes(app: Express, dependencies: WebAppDependencies): void {
  app.post("/api/projects/resolve", async (req: Request, res: Response) => {
    const parsed = parseProjectResolveRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, code: "VALIDATION_ERROR" });
      return;
    }

    if (!dependencies.projectRouter) {
      res.status(503).json({ error: "Project routing is unavailable", code: "PROJECT_ROUTER_UNAVAILABLE" });
      return;
    }

    try {
      const { query, topK } = parsed.value;
      const resolution = await dependencies.projectRouter.resolve(query, { topK });
      res.json(
        buildEnvelope(
          { query, topK },
          resolution,
          {
            routing: {
              candidateCount: resolution.candidates.length,
              decision: resolution.decision,
              durationMs: resolution.durationMs,
            },
          },
          resolution.decision === "abstain"
            ? ["No indexed project had enough evidence for this query."]
            : resolution.decision === "multiple"
              ? ["Several projects have similar evidence; inspect the candidates before choosing one."]
              : [],
        ),
      );
    } catch (error: unknown) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
        code: "INTERNAL_ERROR",
      });
    }
  });
}
