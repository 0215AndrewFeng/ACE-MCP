import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { Logger } from "../common/logger.js";
import {
  MAX_PROJECT_ROUTE_IDENTIFIERS,
  MAX_PROJECT_ROUTE_TERM_LENGTH,
  MAX_PROJECT_ROUTE_TERMS,
  MAX_QUERY_LENGTH,
  type IndexedFileRecord,
  type ProjectRouteMatch,
  type SearchFilters,
  type SearchResult,
} from "../common/types.js";
import type {
  SQLiteSearchCandidateGroups,
  SQLiteSearchCandidateStrategies,
  SQLiteSearchWorkerData,
  SQLiteSearchWorkerRequest,
  SQLiteSearchWorkerResponse,
} from "./sqliteSearchWorkerProtocol.js";

const SQLITE_SEARCH_WORKER_IDLE_MS = 1_000;
const SQLITE_SEARCH_WORKER_POOL_SIZE_DEFAULT = 2;
const SQLITE_SEARCH_WORKER_QUEUE_MAX_PENDING_DEFAULT = 64;
const SQLITE_SEARCH_WORKER_QUEUE_DEADLINE_MS_DEFAULT = 5_000;

type SQLiteSearchWorkerResult = IndexedFileRecord[] | ProjectRouteMatch[] | SearchResult[] | SQLiteSearchCandidateGroups;
type SearchWorker = ChildProcess | Worker;

interface PendingRequest {
  active: boolean;
  deadlineAt: number;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  enqueuedAt: number;
  key: string;
  message: SQLiteSearchWorkerRequest;
  queued: boolean;
  reject: (error: Error) => void;
  resolve: (value: SQLiteSearchWorkerResult) => void;
  worker: SearchWorker | null;
}

export interface SQLiteSearchWorkerDiagnostics {
  activeRequests: number;
  liveWorkers: number;
  pendingRequests: number;
  queueMs: {
    currentMax: number;
    last: number;
    max: number;
    samples: number;
    total: number;
  };
}

export interface SQLiteSearchWorkerClientOptions {
  createChildProcess?: () => ChildProcess;
  poolSize?: number;
  queueDeadlineMs?: number;
  queueMaxPending?: number;
}

export class SQLiteSearchWorkerOverloadError extends Error {
  public override readonly name = "SQLiteSearchWorkerOverloadError";
}

export class SQLiteSearchWorkerQueueTimeoutError extends Error {
  public override readonly name = "SQLiteSearchWorkerQueueTimeoutError";
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

function normalizePositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.min(maximum, Math.floor(value!)) : fallback;
}

function buildRequestKey(request: SQLiteSearchWorkerRequest, deadlineMs: number): string {
  return JSON.stringify({ deadlineMs, method: request.method, payload: request.payload });
}

export class SQLiteSearchWorkerClient {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlight = new Map<string, Promise<SQLiteSearchWorkerResult>>();
  private readonly liveWorkers = new Set<SearchWorker>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly poolSize: number;
  private readonly queueDeadlineMs: number;
  private readonly queueMaxPending: number;
  private readonly retiredWorkers = new WeakSet<SearchWorker>();
  private readonly shuttingDownWorkers = new WeakSet<SearchWorker>();
  private readonly terminatingWorkers = new Map<SearchWorker, Promise<void>>();
  private nextRequestId = 1;
  private queueLastMs = 0;
  private queueMaxMs = 0;
  private queueSamples = 0;
  private queueTotalMs = 0;

  public constructor(
    private readonly workerData: SQLiteSearchWorkerData,
    private readonly logger: Logger,
    private readonly options: SQLiteSearchWorkerClientOptions = {},
  ) {
    this.poolSize = normalizePositiveInteger(options.poolSize, SQLITE_SEARCH_WORKER_POOL_SIZE_DEFAULT, 16);
    this.queueMaxPending = normalizePositiveInteger(
      options.queueMaxPending,
      SQLITE_SEARCH_WORKER_QUEUE_MAX_PENDING_DEFAULT,
      1_024,
    );
    this.queueDeadlineMs = normalizePositiveInteger(
      options.queueDeadlineMs,
      SQLITE_SEARCH_WORKER_QUEUE_DEADLINE_MS_DEFAULT,
      60_000,
    );
  }

  public close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.clearIdleShutdownTimer();
    this.rejectAll(new Error("SQLite search worker closed"));
    const workers = new Set([...this.liveWorkers, ...this.terminatingWorkers.keys()]);
    this.closePromise = Promise.all([...workers].map((worker) => this.stopWorker(worker))).then(() => {});
    return this.closePromise;
  }

  public getDiagnostics(): SQLiteSearchWorkerDiagnostics {
    const now = Date.now();
    const requests = [...this.pending.values()];
    return {
      activeRequests: requests.filter((request) => request.active).length,
      liveWorkers: this.liveWorkers.size,
      pendingRequests: requests.filter((request) => !request.active).length,
      queueMs: {
        currentMax: Math.max(
          ...requests
            .filter((request) => !request.active)
            .map((request) => Math.max(0, now - request.enqueuedAt)),
          0,
        ),
        last: this.queueLastMs,
        max: this.queueMaxMs,
        samples: this.queueSamples,
        total: this.queueTotalMs,
      },
    };
  }

  public getFilePreviewResults(projectId: string, relativePaths: string[]): Promise<SearchResult[]> {
    return this.request({ id: 0, method: "getFilePreviewResults", payload: { projectId, relativePaths } });
  }

  public listProjectFiles(projectId: string): Promise<IndexedFileRecord[]> {
    return this.request({ id: 0, method: "listProjectFiles", payload: { projectId } });
  }

  public searchCandidates(
    projectId: string,
    strategies: SQLiteSearchCandidateStrategies,
    filters?: SearchFilters,
    queueDeadlineMs?: number,
  ): Promise<SQLiteSearchCandidateGroups> {
    return this.request(
      { id: 0, method: "searchCandidates", payload: { filters, projectId, strategies } },
      queueDeadlineMs,
    );
  }

  public searchProjectRoutes(
    ftsQuery: string | null,
    exactSymbols: string[],
    limit: number,
    excludedProjectRootPaths: string[] = [],
    routeTerms: string[] = [],
  ): Promise<ProjectRouteMatch[]> {
    if (ftsQuery && ftsQuery.length > MAX_QUERY_LENGTH) {
      return Promise.reject(new Error(`Project route FTS query exceeds ${MAX_QUERY_LENGTH} characters`));
    }
    const boundedExactSymbols = exactSymbols
      .slice(0, MAX_PROJECT_ROUTE_IDENTIFIERS)
      .map((symbol) => symbol.slice(0, MAX_PROJECT_ROUTE_TERM_LENGTH));
    const boundedRouteTerms = routeTerms
      .slice(0, MAX_PROJECT_ROUTE_TERMS)
      .map((term) => term.slice(0, MAX_PROJECT_ROUTE_TERM_LENGTH));
    return this.request({
      id: 0,
      method: "searchProjectRoutes",
      payload: {
        excludedProjectRootPaths,
        exactSymbols: boundedExactSymbols,
        ftsQuery,
        limit,
        routeTerms: boundedRouteTerms,
      },
    });
  }

  public searchByPath(projectId: string, tokens: string[], limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.request({ id: 0, method: "searchByPath", payload: { filters, limit, projectId, tokens } });
  }

  public searchBySemantic(projectId: string, semanticTerms: string[], limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.request({ id: 0, method: "searchBySemantic", payload: { filters, limit, projectId, semanticTerms } });
  }

  public searchBySymbols(projectId: string, tokens: string[], limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.request({ id: 0, method: "searchBySymbols", payload: { filters, limit, projectId, tokens } });
  }

  public searchByText(projectId: string, ftsQuery: string, limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.request({ id: 0, method: "searchByText", payload: { filters, ftsQuery, limit, projectId } });
  }

  public searchByTextSubstrings(projectId: string, tokens: string[], limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.request({ id: 0, method: "searchByTextSubstrings", payload: { filters, limit, projectId, tokens } });
  }

  private createWorker(): SearchWorker {
    if (this.closed) {
      throw new Error("SQLite search worker closed");
    }
    let worker: SearchWorker;
    if (this.options.createChildProcess) {
      worker = this.options.createChildProcess();
      worker.unref();
      worker.channel?.unref();
      this.attachChildProcess(worker);
    } else if (isSourceRuntime()) {
      worker = fork(fileURLToPath(getWorkerUrl()), [], {
        env: { ...process.env, ACE_MCP_SQLITE_SEARCH_WORKER_DATA: JSON.stringify(this.workerData) },
        execArgv: getTsxExecArgv(),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      worker.unref();
      worker.channel?.unref();
      this.attachChildProcess(worker);
    } else {
      worker = new Worker(getWorkerUrl(), { workerData: this.workerData });
      worker.unref();
      this.attachWorkerThread(worker);
    }
    this.liveWorkers.add(worker);
    return worker;
  }

  private attachChildProcess(worker: ChildProcess): void {
    worker.on("message", (message) => this.handleMessage(worker, message as SQLiteSearchWorkerResponse));
    worker.on("error", (error) => this.handleWorkerError(worker, error));
    worker.on("exit", (code, signal) => this.handleWorkerExit(worker, code, signal));
  }

  private attachWorkerThread(worker: Worker): void {
    worker.on("message", (message: SQLiteSearchWorkerResponse) => this.handleMessage(worker, message));
    worker.on("error", (error) => this.handleWorkerError(worker, error));
    worker.on("exit", (code) => this.handleWorkerExit(worker, code, null));
  }

  private handleMessage(worker: SearchWorker, message: SQLiteSearchWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending || pending.worker !== worker) {
      return;
    }
    this.finishRequest(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      const error = new Error(message.error.message);
      if (message.error.stack) error.stack = message.error.stack;
      pending.reject(error);
    }
    this.dispatchQueuedRequests();
    this.scheduleIdleShutdown();
  }

  private handleWorkerError(worker: SearchWorker, error: Error): void {
    if (this.shuttingDownWorkers.has(worker)) return;
    this.logger.warn("sqlite search worker failed", { error: error.stack ?? error.message });
    this.rejectWorkerRequests(worker, error);
    this.retireWorker(worker);
    this.dispatchQueuedRequests();
  }

  private handleWorkerExit(worker: SearchWorker, code: number | null, signal: NodeJS.Signals | null): void {
    const expectedShutdown = this.shuttingDownWorkers.has(worker);
    const retiredWorker = this.retiredWorkers.has(worker);
    this.liveWorkers.delete(worker);
    this.shuttingDownWorkers.delete(worker);
    this.retiredWorkers.delete(worker);
    if (!expectedShutdown && !retiredWorker) {
      const suffix = signal ? ` from signal ${signal}` : ` with code ${String(code)}`;
      const error = new Error(`SQLite search worker exited${suffix}`);
      this.logger.warn("sqlite search worker exited unexpectedly", { code, signal });
      this.rejectWorkerRequests(worker, error);
    }
    this.dispatchQueuedRequests();
  }

  private request<T extends SQLiteSearchWorkerResult>(
    request: SQLiteSearchWorkerRequest,
    queueDeadlineMs = this.queueDeadlineMs,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("SQLite search worker closed"));
    }
    this.clearIdleShutdownTimer();
    const effectiveDeadlineMs = normalizePositiveInteger(
      queueDeadlineMs,
      this.queueDeadlineMs,
      this.queueDeadlineMs,
    );
    const key = buildRequestKey(request, effectiveDeadlineMs);
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const queuedCount = [...this.pending.values()].filter((pending) => !pending.active).length;
    const hasCapacity = this.getIdleWorker() !== null || this.getOccupiedWorkerCount() < this.poolSize;
    if (!hasCapacity && queuedCount >= this.queueMaxPending) {
      return Promise.reject(new SQLiteSearchWorkerOverloadError(
        `SQLite search worker queue is full (${this.queueMaxPending} pending requests)`,
      ));
    }

    const id = this.nextRequestId++;
    const message = { ...request, id } as SQLiteSearchWorkerRequest;
    const enqueuedAt = Date.now();
    const operation = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        active: false,
        deadlineAt: enqueuedAt + effectiveDeadlineMs,
        deadlineTimer: null,
        enqueuedAt,
        key,
        message,
        queued: false,
        reject,
        resolve: (value) => resolve(value as T),
        worker: null,
      });
    });
    this.inFlight.set(key, operation);
    void operation.then(
      () => this.clearInFlight(key, operation),
      () => this.clearInFlight(key, operation),
    );
    this.armRequestDeadline(this.pending.get(id)!);
    this.dispatchQueuedRequests();
    return operation;
  }

  private clearInFlight(key: string, operation: Promise<SQLiteSearchWorkerResult>): void {
    if (this.inFlight.get(key) === operation) {
      this.inFlight.delete(key);
    }
  }

  private dispatchQueuedRequests(): void {
    if (this.closed) return;
    for (const pending of this.pending.values()) {
      if (pending.active) continue;
      if (Date.now() >= pending.deadlineAt) {
        this.expireRequest(pending);
        continue;
      }
      let worker = this.getIdleWorker();
      if (!worker && this.getOccupiedWorkerCount() < this.poolSize) {
        try {
          worker = this.createWorker();
        } catch (error: unknown) {
          this.finishRequest(pending.message.id);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
      }
      if (!worker) {
        pending.queued = true;
        continue;
      }
      this.dispatchRequest(pending, worker);
    }
  }

  private dispatchRequest(pending: PendingRequest, worker: SearchWorker): void {
    pending.active = true;
    pending.worker = worker;
    const queueMs = Math.max(0, Date.now() - pending.enqueuedAt);
    if (pending.queued) {
      this.queueLastMs = queueMs;
      this.queueMaxMs = Math.max(this.queueMaxMs, queueMs);
      this.queueSamples += 1;
      this.queueTotalMs += queueMs;
    }
    try {
      if (worker instanceof Worker) {
        worker.postMessage(pending.message);
      } else {
        if (!worker.connected) throw new Error("SQLite search worker IPC channel is disconnected");
        worker.send(pending.message, (error) => {
          if (error) this.rejectRequest(pending.message.id, worker!, error);
        });
      }
    } catch (error: unknown) {
      this.rejectRequest(
        pending.message.id,
        worker,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private armRequestDeadline(pending: PendingRequest): void {
    if (pending.deadlineTimer) return;
    const remainingMs = Math.max(0, pending.deadlineAt - Date.now());
    pending.deadlineTimer = setTimeout(() => {
      if (this.pending.get(pending.message.id) !== pending) return;
      this.expireRequest(pending);
    }, remainingMs);
    pending.deadlineTimer.unref();
  }

  private expireRequest(pending: PendingRequest): void {
    const deadlineMs = Math.max(0, pending.deadlineAt - pending.enqueuedAt);
    const error = new SQLiteSearchWorkerQueueTimeoutError(
      `SQLite search worker request deadline exceeded after ${deadlineMs}ms`,
    );
    if (pending.active && pending.worker) {
      const worker = pending.worker;
      this.rejectWorkerRequests(worker, error);
      this.retireWorker(worker);
      this.dispatchQueuedRequests();
    } else {
      this.finishRequest(pending.message.id);
      pending.reject(error);
    }
    this.scheduleIdleShutdown();
  }

  private getIdleWorker(): SearchWorker | null {
    for (const worker of this.liveWorkers) {
      if (this.retiredWorkers.has(worker) || this.shuttingDownWorkers.has(worker)) continue;
      const busy = [...this.pending.values()].some((pending) => pending.active && pending.worker === worker);
      if (!busy) return worker;
    }
    return null;
  }

  private getUsableWorkerCount(): number {
    return [...this.liveWorkers].filter(
      (worker) => !this.retiredWorkers.has(worker) && !this.shuttingDownWorkers.has(worker),
    ).length;
  }

  private getOccupiedWorkerCount(): number {
    return new Set([...this.liveWorkers, ...this.terminatingWorkers.keys()]).size;
  }

  private finishRequest(id: number): void {
    const pending = this.pending.get(id);
    if (pending?.deadlineTimer) clearTimeout(pending.deadlineTimer);
    this.pending.delete(id);
  }

  private rejectRequest(id: number, worker: SearchWorker, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending || pending.worker !== worker) return;
    this.finishRequest(id);
    pending.reject(error);
    this.dispatchQueuedRequests();
    this.scheduleIdleShutdown();
  }

  private rejectWorkerRequests(worker: SearchWorker, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.finishRequest(id);
      pending.reject(error);
    }
    this.scheduleIdleShutdown();
  }

  private retireWorker(worker: SearchWorker): void {
    this.retiredWorkers.add(worker);
    void this.stopWorker(worker).then(
      () => this.dispatchQueuedRequests(),
      (error: unknown) => {
        this.logger.warn("sqlite search worker termination failed", {
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
        this.dispatchQueuedRequests();
      },
    );
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearIdleShutdownTimer(): void {
    if (!this.idleShutdownTimer) return;
    clearTimeout(this.idleShutdownTimer);
    this.idleShutdownTimer = null;
  }

  private scheduleIdleShutdown(): void {
    if (this.closed || this.pending.size > 0 || this.getUsableWorkerCount() === 0 || this.idleShutdownTimer) return;
    this.idleShutdownTimer = setTimeout(() => {
      this.idleShutdownTimer = null;
      if (this.pending.size > 0) return;
      for (const worker of [...this.liveWorkers]) {
        if (this.retiredWorkers.has(worker) || this.shuttingDownWorkers.has(worker)) continue;
        void this.stopWorker(worker).catch((error: unknown) => {
          this.logger.warn("sqlite search worker idle shutdown failed", {
            error: error instanceof Error ? error.stack ?? error.message : String(error),
          });
        });
      }
    }, SQLITE_SEARCH_WORKER_IDLE_MS);
    this.idleShutdownTimer.unref();
  }

  private stopWorker(worker: SearchWorker): Promise<void> {
    const terminating = this.terminatingWorkers.get(worker);
    if (terminating) return terminating;
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
      this.shuttingDownWorkers.delete(worker);
      if (this.terminatingWorkers.get(worker) === tracked) this.terminatingWorkers.delete(worker);
    });
    this.terminatingWorkers.set(worker, tracked);
    return tracked;
  }
}
