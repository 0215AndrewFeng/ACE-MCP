import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { Logger } from "../common/logger.js";
import type { SearchFilters, SearchResult } from "../common/types.js";
import type {
  SQLiteSearchWorkerData,
  SQLiteSearchWorkerRequest,
  SQLiteSearchWorkerResponse,
} from "./sqliteSearchWorkerProtocol.js";

const SQLITE_SEARCH_WORKER_IDLE_MS = 1_000;

interface PendingRequest<T> {
  method: SQLiteSearchWorkerRequest["method"];
  reject: (error: Error) => void;
  resolve: (value: T) => void;
}

function getWorkerUrl(): URL {
  const sourceExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./sqliteSearchWorker${sourceExtension}`, import.meta.url);
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

export class SQLiteSearchWorkerClient {
  private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, PendingRequest<SearchResult[]>>();
  private readonly shuttingDownWorkers = new WeakSet<ChildProcess | Worker>();
  private nextRequestId = 1;
  private worker: ChildProcess | Worker | null = null;

  public constructor(
    private readonly workerData: SQLiteSearchWorkerData,
    private readonly logger: Logger,
  ) {}

  public async close(): Promise<void> {
    this.clearIdleShutdownTimer();
    const worker = this.worker;
    this.worker = null;
    this.rejectAll(new Error("SQLite search worker closed"));

    if (worker instanceof Worker) {
      this.shuttingDownWorkers.add(worker);
      await worker.terminate();
    } else if (worker) {
      this.shuttingDownWorkers.add(worker);
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
    }
  }

  public getFilePreviewResults(projectId: string, relativePaths: string[]): Promise<SearchResult[]> {
    return this.request({
      id: 0,
      method: "getFilePreviewResults",
      payload: { projectId, relativePaths },
    });
  }

  public searchByPath(projectId: string, tokens: string[], limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.request({
      id: 0,
      method: "searchByPath",
      payload: { filters, limit, projectId, tokens },
    });
  }

  public searchBySemantic(projectId: string, semanticTerms: string[], limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.request({
      id: 0,
      method: "searchBySemantic",
      payload: { filters, limit, projectId, semanticTerms },
    });
  }

  public searchBySymbols(projectId: string, tokens: string[], limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.request({
      id: 0,
      method: "searchBySymbols",
      payload: { filters, limit, projectId, tokens },
    });
  }

  public searchByText(projectId: string, ftsQuery: string, limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.request({
      id: 0,
      method: "searchByText",
      payload: { filters, ftsQuery, limit, projectId },
    });
  }

  public searchByTextSubstrings(projectId: string, tokens: string[], limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.request({
      id: 0,
      method: "searchByTextSubstrings",
      payload: { filters, limit, projectId, tokens },
    });
  }

  private ensureWorker(): ChildProcess | Worker {
    if (this.worker) {
      return this.worker;
    }

    if (isSourceRuntime()) {
      const worker = fork(fileURLToPath(getWorkerUrl()), [], {
        env: {
          ...process.env,
          ACE_MCP_SQLITE_SEARCH_WORKER_DATA: JSON.stringify(this.workerData),
        },
        execArgv: getTsxExecArgv(),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      worker.unref();
      worker.channel?.unref();
      worker.on("message", (message) => this.handleMessage(message as SQLiteSearchWorkerResponse));
      worker.on("error", (error) => {
        this.logger.warn("sqlite search worker failed", {
          error: error.message,
        });
        this.worker = null;
        this.rejectAll(error);
      });
      worker.on("exit", (code) => {
        const expectedShutdown = this.shuttingDownWorkers.has(worker);
        this.shuttingDownWorkers.delete(worker);
        if (this.worker === worker) {
          this.worker = null;
        }
        if (!expectedShutdown && code !== 0 && code !== null) {
          const error = new Error(`SQLite search worker exited with code ${code}`);
          this.logger.warn("sqlite search worker exited unexpectedly", { code });
          this.rejectAll(error);
        }
      });

      this.worker = worker;
      return worker;
    }

    const worker = new Worker(getWorkerUrl(), {
      workerData: this.workerData,
    });
    worker.unref();
    worker.on("message", (message: SQLiteSearchWorkerResponse) => this.handleMessage(message));
    worker.on("error", (error) => {
      this.logger.warn("sqlite search worker failed", {
        error: error.message,
      });
      this.worker = null;
      this.rejectAll(error);
    });
    worker.on("exit", (code) => {
      const expectedShutdown = this.shuttingDownWorkers.has(worker);
      this.shuttingDownWorkers.delete(worker);
      if (this.worker === worker) {
        this.worker = null;
      }
      if (!expectedShutdown && code !== 0) {
        const error = new Error(`SQLite search worker exited with code ${code}`);
        this.logger.warn("sqlite search worker exited unexpectedly", { code });
        this.rejectAll(error);
      }
    });

    this.worker = worker;
    return worker;
  }

  private handleMessage(message: SQLiteSearchWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
      this.scheduleIdleShutdown();
      return;
    }

    const error = new Error(message.error.message);
    if (message.error.stack) {
      error.stack = message.error.stack;
    }
    pending.reject(error);
    this.scheduleIdleShutdown();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private request(request: SQLiteSearchWorkerRequest): Promise<SearchResult[]> {
    this.clearIdleShutdownTimer();
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    const message = { ...request, id };

    return new Promise<SearchResult[]>((resolve, reject) => {
      this.pending.set(id, { method: message.method, reject, resolve });
      try {
        if (worker instanceof Worker) {
          worker.postMessage(message);
        } else {
          if (!worker.connected) {
            throw new Error("SQLite search worker IPC channel is disconnected");
          }
          worker.send(message, (error) => {
            if (!error) {
              return;
            }
            const pending = this.pending.get(id);
            if (!pending) {
              return;
            }
            this.pending.delete(id);
            pending.reject(error);
            this.scheduleIdleShutdown();
          });
        }
      } catch (error: unknown) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private clearIdleShutdownTimer(): void {
    if (this.idleShutdownTimer) {
      clearTimeout(this.idleShutdownTimer);
      this.idleShutdownTimer = null;
    }
  }

  private scheduleIdleShutdown(): void {
    if (this.pending.size > 0 || !this.worker || this.idleShutdownTimer) {
      return;
    }

    this.idleShutdownTimer = setTimeout(() => {
      this.idleShutdownTimer = null;
      const worker = this.worker;
      if (!worker || this.pending.size > 0) {
        return;
      }

      this.worker = null;
      this.shuttingDownWorkers.add(worker);
      if (worker instanceof Worker) {
        void worker.terminate();
      } else {
        worker.kill();
      }
    }, SQLITE_SEARCH_WORKER_IDLE_MS);
    this.idleShutdownTimer.unref();
  }
}
