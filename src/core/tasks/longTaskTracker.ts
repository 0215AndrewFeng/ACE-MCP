export type LongTaskType = "index" | "summary";
export type LongTaskStatus = "queued" | "running" | "succeeded" | "failed";

export interface LongTaskInfo<TResult = unknown> {
  completedAt?: string;
  durationMs?: number;
  elapsedMs: number;
  error?: {
    code?: string;
    message: string;
  };
  projectRootPath: string;
  startedAt: string;
  status: LongTaskStatus;
  taskId: string;
  type: LongTaskType;
  result?: TResult;
}

interface LongTaskRecord<TResult = unknown> {
  completedAt?: number;
  completedAtIso?: string;
  durationMs?: number;
  error?: {
    code?: string;
    message: string;
  };
  projectRootPath: string;
  startedAt: number;
  startedAtIso: string;
  status: LongTaskStatus;
  taskId: string;
  type: LongTaskType;
  result?: TResult;
}

export class LongTaskTracker {
  private readonly tasks = new Map<string, LongTaskRecord>();
  private sequence = 0;

  public constructor(private readonly maxRetainedTasks = 100) {}

  public start(type: LongTaskType, projectRootPath: string): string {
    this.sequence += 1;
    const taskId = `${type}-${Date.now()}-${this.sequence}`;
    this.tasks.set(taskId, {
      projectRootPath,
      startedAt: Date.now(),
      startedAtIso: new Date().toISOString(),
      status: "running",
      taskId,
      type,
    });
    return taskId;
  }

  public run<TResult>(type: LongTaskType, projectRootPath: string, work: () => Promise<TResult>): LongTaskInfo<TResult> {
    const taskId = this.start(type, projectRootPath);
    const record = this.tasks.get(taskId);
    if (!record) {
      throw new Error(`Task was not created: ${taskId}`);
    }

    void work()
      .then((result) => {
        this.markSucceeded(taskId, result);
      })
      .catch((error: unknown) => {
        this.markFailed(taskId, error);
      });

    return this.toInfo(record) as LongTaskInfo<TResult>;
  }

  public finish(taskId: string, result?: unknown): void {
    this.markSucceeded(taskId, result);
  }

  public list(): LongTaskInfo[] {
    return [...this.tasks.values()].map((task) => this.toInfo(task));
  }

  public get(taskId: string): LongTaskInfo | undefined {
    const task = this.tasks.get(taskId);
    return task ? this.toInfo(task) : undefined;
  }

  public listActive(): LongTaskInfo[] {
    return this.list().filter((task) => task.status === "queued" || task.status === "running");
  }

  private markSucceeded(taskId: string, result: unknown): void {
    const record = this.tasks.get(taskId);
    if (!record) return;
    const completedAt = Date.now();
    record.completedAt = completedAt;
    record.completedAtIso = new Date(completedAt).toISOString();
    record.durationMs = completedAt - record.startedAt;
    record.result = result;
    record.status = "succeeded";
    this.pruneCompleted();
  }

  private markFailed(taskId: string, error: unknown): void {
    const record = this.tasks.get(taskId);
    if (!record) return;
    const completedAt = Date.now();
    const appError = error as { code?: unknown; message?: unknown };
    record.completedAt = completedAt;
    record.completedAtIso = new Date(completedAt).toISOString();
    record.durationMs = completedAt - record.startedAt;
    record.error = {
      code: typeof appError.code === "string" ? appError.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    };
    record.status = "failed";
    this.pruneCompleted();
  }

  private pruneCompleted(): void {
    if (this.tasks.size <= this.maxRetainedTasks) return;
    const completed = [...this.tasks.values()]
      .filter((task) => task.status === "succeeded" || task.status === "failed")
      .sort((a, b) => (a.completedAt ?? a.startedAt) - (b.completedAt ?? b.startedAt));

    for (const task of completed) {
      if (this.tasks.size <= this.maxRetainedTasks) break;
      this.tasks.delete(task.taskId);
    }
  }

  private toInfo<TResult = unknown>(task: LongTaskRecord<TResult>): LongTaskInfo<TResult> {
    const now = Date.now();
    return {
      completedAt: task.completedAtIso,
      durationMs: task.durationMs,
      elapsedMs: task.completedAt ? task.completedAt - task.startedAt : now - task.startedAt,
      error: task.error,
      projectRootPath: task.projectRootPath,
      result: task.result,
      startedAt: task.startedAtIso,
      status: task.status,
      taskId: task.taskId,
      type: task.type,
    };
  }
}
