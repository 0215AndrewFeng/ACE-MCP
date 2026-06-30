import type { Express, Request, Response } from "express";

import type { WebAppDependencies } from "../types.js";

export function registerTaskRoutes(app: Express, dependencies: WebAppDependencies): void {
  app.get("/api/tasks", (_req: Request, res: Response) => {
    res.json({ tasks: dependencies.longTaskTracker?.list() ?? [] });
  });

  app.get("/api/tasks/:taskId", (req: Request, res: Response) => {
    const task = dependencies.longTaskTracker?.get(String(req.params.taskId));
    if (!task) {
      res.status(404).json({ error: "Task not found", code: "TASK_NOT_FOUND" });
      return;
    }
    res.json({ task });
  });
}
