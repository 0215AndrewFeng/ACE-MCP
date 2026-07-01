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

  app.post("/api/tasks/:taskId/cancel", (req: Request, res: Response) => {
    const taskId = String(req.params.taskId);
    const existing = dependencies.longTaskTracker?.get(taskId);
    if (!existing) {
      res.status(404).json({ error: "Task not found", code: "TASK_NOT_FOUND" });
      return;
    }
    const task = dependencies.longTaskTracker?.cancel(taskId);
    if (!task) {
      res.status(409).json({ error: "Task is not cancelable", code: "TASK_NOT_CANCELABLE", task: existing });
      return;
    }
    res.json({ task });
  });
}
