import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Logger } from "./logger.js";

async function createLoggerEnvironment(): Promise<{
  cleanup: () => Promise<void>;
  logFilePath: string;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-logger-test-"));
  return {
    cleanup: () => rm(tempDir, { force: true, recursive: true }),
    logFilePath: path.join(tempDir, "ace-mcp.log"),
  };
}

test("Logger applies the minimum level to file output", async () => {
  const env = await createLoggerEnvironment();

  try {
    const logger = new Logger(env.logFilePath, "info", { consoleWriter: () => undefined });

    logger.debug("debug details");
    logger.info("service ready");

    const lines = (await readFile(env.logFilePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.message), ["service ready"]);
  } finally {
    await env.cleanup();
  }
});

test("Logger keeps only the configured number of bounded archives", async () => {
  const env = await createLoggerEnvironment();

  try {
    const maxFileSizeBytes = 320;
    const logger = new Logger(env.logFilePath, "info", {
      consoleWriter: () => undefined,
      maxArchiveFiles: 2,
      maxFileSizeBytes,
    });

    for (let index = 0; index < 20; index += 1) {
      logger.info("bounded log entry", { index, padding: "x".repeat(80) });
    }

    const files = (await readdir(path.dirname(env.logFilePath)))
      .filter((fileName) => fileName.startsWith("ace-mcp.log"))
      .sort();
    assert.deepEqual(files, ["ace-mcp.log", "ace-mcp.log.1", "ace-mcp.log.2"]);
    assert.equal(files.includes("ace-mcp.log.3"), false);
    for (const fileName of files) {
      const fileStats = await stat(path.join(path.dirname(env.logFilePath), fileName));
      assert.ok(fileStats.size <= maxFileSizeBytes, `${fileName} exceeded ${maxFileSizeBytes} bytes`);
    }
  } finally {
    await env.cleanup();
  }
});

test("Logger contains stderr EPIPE failures", async () => {
  const env = await createLoggerEnvironment();
  let consoleWriteCount = 0;

  try {
    const logger = new Logger(env.logFilePath, "info", {
      consoleWriter: () => {
        consoleWriteCount += 1;
        throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      },
    });

    assert.doesNotThrow(() => logger.info("survives broken stderr"));
    assert.equal(consoleWriteCount, 1);
    assert.match(await readFile(env.logFilePath, "utf8"), /survives broken stderr/);
  } finally {
    await env.cleanup();
  }
});

test("Logger contains metadata serialization failures", async () => {
  const env = await createLoggerEnvironment();
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  try {
    const logger = new Logger(env.logFilePath, "info", { consoleWriter: () => undefined });

    assert.doesNotThrow(() => logger.info("survives circular metadata", circular));
    const entry = JSON.parse((await readFile(env.logFilePath, "utf8")).trim());
    assert.equal(entry.message, "survives circular metadata");
    assert.equal(entry.metadataSerializationFailed, true);
  } finally {
    await env.cleanup();
  }
});
