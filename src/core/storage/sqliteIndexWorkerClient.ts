import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { Logger } from "../common/logger.js";
import type { ProjectInfo } from "../common/types.js";
import type {
  FinalizeProjectIndexPayload,
  FinalizeProjectIndexResult,
  PrepareProjectIndexResult,
  SQLiteIndexFileBatch,
  SQLiteIndexWorkerData,
  SQLiteIndexWorkerRequest,
  SQLiteIndexWorkerResponse,
} from "./sqliteIndexWorkerProtocol.js";

const SQLITE_INDEX_WORKER_IDLE_MS = 1_000;

interface PendingRequest {
  method: SQLiteIndexWorkerRequest["method"];
  reject: (error: Error) => void;
  resolve: (value: FinalizeProjectIndexResult | PrepareProjectIndexResult | null) => void;
  worker: ChildProcess | Worker;
}

interface SQLiteIndexWorkerClientOptions {
  createChildProcess?: () => ChildProcess;
  idleMs?: number;
  workerUrl?: URL;
}

function defaultWorkerUrl(): URL {
  const sourceExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./sqliteIndexWorker${sourceExtension}`, import.meta.url);
}

function getTsxExecArgv(): string[] {
  for (let index = 0; index < process.execArgv.length; index++) {
    const arg = process.execArgv[index];
    if (arg === "--import" && process.execArgv[index + 1] === "tsx") {
      return ["--import", "tsx"];
    }
    if (arg === "--import=tsx") {
      return ["--import=tsx"];
    }
  }
  return ["--import", "tsx"];
}

function isSourceRuntime(): boolean {
  return import.meta.url.endsWith(".ts");
}

export class SQLiteIndexWorkerClient {
  private activeLeases = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRequestId = 1;
  private readonly liveWorkers = new Set<ChildProcess | Worker>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly retiredWorkers = new WeakSet<ChildProcess | Worker>();
  private readonly shuttingDownWorkers = new WeakSet<ChildProcess | Worker>();
  private readonly terminatingWorkers = new Map<ChildProcess | Worker, Promise<void>>();
  private worker: ChildProcess | Worker | null = null;

  public constructor(
    private readonly workerData: SQLiteIndexWorkerData,
    private readonly logger: Logger,
    private readonly options: SQLiteIndexWorkerClientOptions = {},
  ) {}

  public acquireLease(): void {
    if (this.closed) {
      throw new Error("SQLite index worker closed");
    }
    this.activeLeases += 1;
    this.clearIdleShutdownTimer();
  }

  public releaseLease(): void {
    if (this.activeLeases === 0) {
      if (this.closed) {
        return;
      }
      throw new Error("SQLite index worker lease released without a matching acquire");
    }
    this.activeLeases -= 1;
    this.scheduleIdleShutdown();
  }

  /** Forceful close. Owners must drain active work before invoking this method. */
  public close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.activeLeases = 0;
    this.clearIdleShutdownTimer();
    this.worker = null;
    this.rejectAll(new Error("SQLite index worker closed"));
    const workers = [...this.liveWorkers];
    this.closePromise = Promise.all(workers.map((worker) => this.stopWorker(worker))).then(() => {});
    return this.closePromise;
  }

  public deleteFiles(projectId: string, relativePaths: string[]): Promise<void> {
    return this.request<void>({ id: 0, method: "deleteFiles", payload: { projectId, relativePaths } });
  }

  public finalizeProjectIndex(
    projectId: string,
    finalization: FinalizeProjectIndexPayload,
  ): Promise<FinalizeProjectIndexResult> {
    return this.request<FinalizeProjectIndexResult>({
      id: 0,
      method: "finalizeProjectIndex",
      payload: { finalization, projectId },
    });
  }

  public ensureSemanticIndex(projectId: string): Promise<void> {
    return this.request<void>({ id: 0, method: "ensureSemanticIndex", payload: { projectId } });
  }

  public prepareProjectIndex(
    projectId: string,
    project: ProjectInfo,
    timestamp: string,
  ): Promise<PrepareProjectIndexResult> {
    return this.request<PrepareProjectIndexResult>({
      id: 0,
      method: "prepareProjectIndex",
      payload: { project, projectId, timestamp },
    });
  }

  public resolveSymbolGraph(projectId: string, changedFileIds: string[]): Promise<void> {
    return this.request<void>({ id: 0, method: "resolveSymbolGraph", payload: { changedFileIds, projectId } });
  }

  public writeChunkVectors(
    entries: Array<{ chunkId: string; embedding: number[]; modelName: string }>,
    projectId: string,
  ): Promise<void> {
    return this.request<void>({ id: 0, method: "writeChunkVectors", payload: { entries, projectId } });
  }

  public writeFileIndexBatch(
    projectId: string,
    files: SQLiteIndexFileBatch[],
    indexedAt: string,
  ): Promise<void> {
    return this.request<void>({ id: 0, method: "writeFileIndexBatch", payload: { files, indexedAt, projectId } });
  }

  private get workerUrl(): URL {
    return this.options.workerUrl ?? defaultWorkerUrl();
  }

  private ensureWorker(): ChildProcess | Worker {
    if (this.closed) {
      throw new Error("SQLite index worker closed");
    }
    if (this.worker) {
      return this.worker;
    }

    if (this.options.createChildProcess) {
      const worker = this.options.createChildProcess();
      worker.unref();
      worker.channel?.unref();
      this.attachChildProcess(worker);
      this.liveWorkers.add(worker);
      this.worker = worker;
      return worker;
    }

    if (isSourceRuntime()) {
      const worker = fork(fileURLToPath(this.workerUrl), [], {
        env: {
          ...process.env,
          ACE_MCP_SQLITE_INDEX_WORKER_DATA: JSON.stringify(this.workerData),
        },
        execArgv: getTsxExecArgv(),
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      worker.unref();
      worker.channel?.unref();
      this.attachChildProcess(worker);
      this.liveWorkers.add(worker);
      this.worker = worker;
      return worker;
    }

    const worker = new Worker(this.workerUrl, { workerData: this.workerData });
    worker.unref();
    this.attachWorkerThread(worker);
    this.liveWorkers.add(worker);
    this.worker = worker;
    return worker;
  }

  private attachChildProcess(worker: ChildProcess): void {
    worker.on("message", (message) => this.handleMessage(message as SQLiteIndexWorkerResponse));
    worker.on("error", (error) => this.handleWorkerError(worker, error));
    worker.on("exit", (code, signal) => this.handleWorkerExit(worker, code, signal));
  }

  private attachWorkerThread(worker: Worker): void {
    worker.on("message", (message: SQLiteIndexWorkerResponse) => this.handleMessage(message));
    worker.on("error", (error) => this.handleWorkerError(worker, error));
    worker.on("exit", (code) => this.handleWorkerExit(worker, code, null));
  }

  private handleMessage(message: SQLiteIndexWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      const error = new Error(message.error.message);
      if (message.error.stack) {
        error.stack = message.error.stack;
      }
      pending.reject(error);
    }
    this.scheduleIdleShutdown();
  }

  private handleWorkerError(worker: ChildProcess | Worker, error: Error): void {
    const expectedShutdown = this.shuttingDownWorkers.has(worker);
    if (this.worker === worker) {
      this.worker = null;
    }
    if (expectedShutdown) {
      return;
    }
    this.retiredWorkers.add(worker);
    this.logger.warn("sqlite index worker failed", { error: error.stack ?? error.message });
    this.rejectWorkerRequests(worker, error);
  }

  private handleWorkerExit(worker: ChildProcess | Worker, code: number | null, signal: NodeJS.Signals | null): void {
    const expectedShutdown = this.shuttingDownWorkers.has(worker);
    const retiredWorker = this.retiredWorkers.has(worker);
    this.liveWorkers.delete(worker);
    this.shuttingDownWorkers.delete(worker);
    this.retiredWorkers.delete(worker);
    if (this.worker === worker) {
      this.worker = null;
    }
    if (expectedShutdown || retiredWorker) {
      return;
    }
    const suffix = signal ? ` from signal ${signal}` : ` with code ${String(code)}`;
    const error = new Error(`SQLite index worker exited${suffix}`);
    this.logger.warn("sqlite index worker exited unexpectedly", { code, signal });
    this.rejectWorkerRequests(worker, error);
  }

  private request<T = void>(request: SQLiteIndexWorkerRequest): Promise<T> {
    this.clearIdleShutdownTimer();
    let worker: ChildProcess | Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.nextRequestId++;
    const message = { ...request, id } as SQLiteIndexWorkerRequest;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method: message.method,
        reject,
        resolve: (value) => resolve(value as T),
        worker,
      });
      try {
        if (worker instanceof Worker) {
          worker.postMessage(message);
        } else if (worker.connected) {
          worker.send(message, (error) => {
            if (error) {
              this.rejectRequest(id, worker, error);
            }
          });
        } else {
          throw new Error("SQLite index worker IPC channel is closed");
        }
      } catch (error) {
        this.rejectRequest(id, worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectRequest(id: number, worker: ChildProcess | Worker, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending || pending.worker !== worker) {
      return;
    }
    this.pending.delete(id);
    pending.reject(error);
    this.scheduleIdleShutdown();
  }

  private rejectWorkerRequests(worker: ChildProcess | Worker, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.worker === worker) {
        this.pending.delete(id);
        pending.reject(error);
      }
    }
    this.scheduleIdleShutdown();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleIdleShutdown(): void {
    if (this.closed || this.activeLeases > 0 || this.pending.size > 0 || !this.worker) {
      return;
    }
    this.clearIdleShutdownTimer();
    const worker = this.worker;
    this.idleShutdownTimer = setTimeout(() => {
      this.idleShutdownTimer = null;
      if (this.worker !== worker || this.activeLeases > 0 || this.pending.size > 0) {
        return;
      }
      this.worker = null;
      void this.stopWorker(worker).catch((error: unknown) => {
        this.logger.warn("sqlite index worker idle shutdown failed", {
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
      });
    }, this.options.idleMs ?? SQLITE_INDEX_WORKER_IDLE_MS);
    this.idleShutdownTimer.unref();
  }

  private clearIdleShutdownTimer(): void {
    if (this.idleShutdownTimer) {
      clearTimeout(this.idleShutdownTimer);
      this.idleShutdownTimer = null;
    }
  }

  private stopWorker(worker: ChildProcess | Worker): Promise<void> {
    const terminating = this.terminatingWorkers.get(worker);
    if (terminating) {
      return terminating;
    }

    this.shuttingDownWorkers.add(worker);
    const operation = (async () => {
      if (worker instanceof Worker) {
        await worker.terminate();
        return;
      }
      await new Promise<void>((resolve) => {
        if (worker.exitCode !== null || worker.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
        worker.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        worker.kill();
      });
    })();
    const tracked = operation.finally(() => {
      this.liveWorkers.delete(worker);
      if (this.terminatingWorkers.get(worker) === tracked) {
        this.terminatingWorkers.delete(worker);
      }
    });
    this.terminatingWorkers.set(worker, tracked);
    return tracked;
  }
}
