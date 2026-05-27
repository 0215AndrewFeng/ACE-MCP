import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  error: 40,
  info: 20,
  warn: 30,
};

/**
 * v4.3.3: Structured NDJSON logger
 * Output format: {"timestamp":"...","level":"info","message":"...","key":"value"}
 * Compatible with jq, ELK, Loki, and other log aggregation tools.
 */
export class Logger {
  public constructor(
    private readonly logFilePath: string,
    private readonly minLevel: LogLevel = "info",
  ) {
    mkdirSync(path.dirname(logFilePath), { recursive: true });
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
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
    const line = JSON.stringify(entry) + "\n";

    appendFileSync(this.logFilePath, line, "utf8");

    // Console output: human-readable format for development
    if (LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.minLevel]) {
      const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
      process.stderr.write(`${entry.timestamp} [${level.toUpperCase()}] ${message}${suffix}\n`);
    }
  }
}
