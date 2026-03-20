import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  error: 40,
  info: 20,
  warn: 30,
};

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

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
    const line = `${timestamp} [${level.toUpperCase()}] ${message}${suffix}\n`;

    appendFileSync(this.logFilePath, line, "utf8");

    if (LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.minLevel]) {
      process.stderr.write(line);
    }
  }
}
