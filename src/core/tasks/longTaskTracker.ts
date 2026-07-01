export type LongTaskType = "index" | "summary";
export type LongTaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export interface LongTaskInfo<TResult = unknown> {
  completedAt?: string;
  durationMs?: number;
  elapsedMs: number;
  error?: {
    code?: string;
    message: string;
  };
  projectRootPath: string;
  reused?: boolean;
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
  key?: string;
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

  public start(type: LongTaskType, projectRootPath: string, key?: string): string {
    this.sequence += 1;
    const taskId = `${type}-${Date.now()}-${this.sequence}`;
    this.tasks.set(taskId, {
      key,
      projectRootPath,
      startedAt: Date.now(),
      startedAtIso: new Date().toISOString(),
      status: "running",
      taskId,
      type,
    });
    return taskId;
  }

  public run<TResult>(type: LongTaskType, projectRootPath: string, work: () => Promise<TResult>, key?: string): LongTaskInfo<TResult> {
    const existing = key ? this.findActiveByKey(key) : undefined;
    if (existing) {
      return { ...this.toInfo(existing), reused: true } as LongTaskInfo<TResult>;
    }

    const taskId = this.start(type, projectRootPath, key);
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

  public cancel(taskId: string): LongTaskInfo | undefined {
    const record = this.tasks.get(taskId);
    if (!record || (record.status !== "queued" && record.status !== "running")) {
      return undefined;
    }
    const completedAt = Date.now();
    record.completedAt = completedAt;
    record.completedAtIso = new Date(completedAt).toISOString();
    record.durationMs = completedAt - record.startedAt;
    record.status = "canceled";
    this.pruneCompleted();
    return this.toInfo(record);
  }

  private markSucceeded(taskId: string, result: unknown): void {
    const record = this.tasks.get(taskId);
    if (!record) return;
    if (record.status === "canceled") return;
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
    if (record.status === "canceled") return;
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
      .filter((task) => task.status === "succeeded" || task.status === "failed" || task.status === "canceled")
      .sort((a, b) => (a.completedAt ?? a.startedAt) - (b.completedAt ?? b.startedAt));

    for (const task of completed) {
      if (this.tasks.size <= this.maxRetainedTasks) break;
      this.tasks.delete(task.taskId);
    }
  }

  private findActiveByKey(key: string): LongTaskRecord | undefined {
    return [...this.tasks.values()].find((task) => task.key === key && (task.status === "queued" || task.status === "running"));
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
