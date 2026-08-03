import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  error: 40,
  info: 20,
  warn: 30,
};

const DEFAULT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_FILES = 3;
const ROTATION_LOCK_STALE_MS = 60_000;

export interface LoggerOptions {
  consoleWriter?: (line: string) => void;
  maxArchiveFiles?: number;
  maxFileSizeBytes?: number;
}

function defaultConsoleWriter(line: string): void {
  writeSync(process.stderr.fd, line);
}

/**
 * v4.3.3: Structured NDJSON logger
 * Output format: {"timestamp":"...","level":"info","message":"...","key":"value"}
 * Compatible with jq, ELK, Loki, and other log aggregation tools.
 */
export class Logger {
  private readonly consoleWriter?: (line: string) => void;
  private readonly maxArchiveFiles: number;
  private readonly maxFileSizeBytes: number;

  public constructor(
    private readonly logFilePath: string,
    private readonly minLevel: LogLevel = "info",
    options: LoggerOptions = {},
  ) {
    mkdirSync(path.dirname(logFilePath), { recursive: true });
    this.consoleWriter = options.consoleWriter
      ?? (process.env.ACE_MCP_LOG_TO_STDERR === "false" ? undefined : defaultConsoleWriter);
    this.maxArchiveFiles = Math.max(0, Math.floor(options.maxArchiveFiles ?? DEFAULT_MAX_ARCHIVE_FILES));
    this.maxFileSizeBytes = Math.max(1, Math.floor(options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES));
  }

  public debug(message: string, meta?: Record<string, unknown>): void {
    this.write("debug", message, meta);
  }

  public error(message: string, meta?: Record<string, unknown>): void {
    this.write("error", message, meta);
  }

  public info(message: string, meta?: Record<string, unknown>): void {
    this.write("info", message, meta);
  }

  public warn(message: string, meta?: Record<string, unknown>): void {
    this.write("warn", message, meta);
  }

  /**
   * v4.3.3: NDJSON structured log format
   * Each line is a valid JSON object for easy parsing and aggregation.
   */
  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) {
      return;
    }

    let entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
    let line: string;
    let consoleSuffix = "";
    try {
      line = JSON.stringify(entry) + "\n";
      consoleSuffix = meta ? ` ${JSON.stringify(meta)}` : "";
    } catch {
      entry = {
        timestamp: entry.timestamp,
        level,
        message,
        metadataSerializationFailed: true,
      };
      line = JSON.stringify(entry) + "\n";
      consoleSuffix = " {\"metadataSerializationFailed\":true}";
    }

    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.logFilePath, line, "utf8");
    } catch {
      // Logging must never take down the server, including on disk-full or permission errors.
    }

    if (this.consoleWriter) {
      try {
        this.consoleWriter(`${entry.timestamp} [${level.toUpperCase()}] ${message}${consoleSuffix}\n`);
      } catch {
        // A closed stderr pipe (EPIPE) must not recurse through uncaughtException logging.
      }
    }
  }

  private rotateIfNeeded(nextLineBytes: number): void {
    let currentSize = 0;
    try {
      currentSize = statSync(this.logFilePath).size;
    } catch {
      return;
    }
    if (currentSize + nextLineBytes <= this.maxFileSizeBytes) {
      return;
    }

    const lockFilePath = `${this.logFilePath}.rotate.lock`;
    let lockFd = this.acquireRotationLock(lockFilePath);
    if (lockFd === undefined) {
      return;
    }

    try {
      currentSize = existsSync(this.logFilePath) ? statSync(this.logFilePath).size : 0;
      if (currentSize + nextLineBytes <= this.maxFileSizeBytes) {
        return;
      }
      if (this.maxArchiveFiles === 0) {
        truncateSync(this.logFilePath, 0);
        return;
      }

      rmSync(`${this.logFilePath}.${this.maxArchiveFiles}`, { force: true });
      for (let index = this.maxArchiveFiles - 1; index >= 1; index -= 1) {
        const source = `${this.logFilePath}.${index}`;
        if (existsSync(source)) {
          renameSync(source, `${this.logFilePath}.${index + 1}`);
        }
      }
      renameSync(this.logFilePath, `${this.logFilePath}.1`);
    } finally {
      closeSync(lockFd);
      try {
        unlinkSync(lockFilePath);
      } catch {
        // A competing cleanup or filesystem error is harmless after releasing the fd.
      }
    }
  }

  private acquireRotationLock(lockFilePath: string): number | undefined {
    try {
      return openSync(lockFilePath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return undefined;
      }
    }

    try {
      if (Date.now() - statSync(lockFilePath).mtimeMs <= ROTATION_LOCK_STALE_MS) {
        return undefined;
      }
      unlinkSync(lockFilePath);
      return openSync(lockFilePath, "wx");
    } catch {
      return undefined;
    }
  }
}
