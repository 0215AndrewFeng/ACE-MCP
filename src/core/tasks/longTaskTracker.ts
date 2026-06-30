export type LongTaskType = "summary";

export interface LongTaskInfo {
  elapsedMs: number;
  projectRootPath: string;
  startedAt: string;
  status: "running";
  taskId: string;
  type: LongTaskType;
}

interface ActiveLongTask {
  projectRootPath: string;
  startedAt: number;
  startedAtIso: string;
  taskId: string;
  type: LongTaskType;
}

export class LongTaskTracker {
  private readonly tasks = new Map<string, ActiveLongTask>();
  private sequence = 0;

  public start(type: LongTaskType, projectRootPath: string): string {
    this.sequence += 1;
    const taskId = `${type}-${Date.now()}-${this.sequence}`;
    this.tasks.set(taskId, {
      projectRootPath,
      startedAt: Date.now(),
      startedAtIso: new Date().toISOString(),
      taskId,
      type,
    });
    return taskId;
  }

  public finish(taskId: string): void {
    this.tasks.delete(taskId);
  }

  public list(): LongTaskInfo[] {
    const now = Date.now();
    return [...this.tasks.values()].map((task) => ({
      elapsedMs: now - task.startedAt,
      projectRootPath: task.projectRootPath,
      startedAt: task.startedAtIso,
      status: "running",
      taskId: task.taskId,
      type: task.type,
    }));
  }
}
