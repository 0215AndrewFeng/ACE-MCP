import type { Express, Request, Response } from "express";

import type { WebAppDependencies } from "../types.js";

export function registerTaskRoutes(app: Express, dependencies: WebAppDependencies): void {
  app.get("/api/tasks", (req: Request, res: Response) => {
    const type = typeof req.query.type === "string" ? req.query.type : "";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const projectRootPath = typeof req.query.projectRootPath === "string" ? req.query.projectRootPath : "";
    const tasks = dependencies.longTaskTracker?.list()
      .filter((task) => !type || task.type === type)
      .filter((task) => !status || task.status === status)
      .filter((task) => !projectRootPath || task.projectRootPath === projectRootPath) ?? [];

    res.json({
      filters: {
        projectRootPath: projectRootPath || undefined,
        status: status || undefined,
        type: type || undefined,
      },
      tasks,
    });
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
