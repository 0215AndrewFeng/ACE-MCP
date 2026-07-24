import { appendFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

interface FixtureRequest {
  id: number;
  method: string;
  payload: { projectId?: string };
}

interface FixtureWorkerData {
  databasePath: string;
}

const data = parentPort
  ? workerData as FixtureWorkerData
  : JSON.parse(process.env.ACE_MCP_SQLITE_INDEX_WORKER_DATA ?? "null") as FixtureWorkerData | null;
if (!data) {
  throw new Error("fixture must be started with worker data");
}

appendFileSync(`${data.databasePath}.pids`, `${process.pid}\n`, "utf8");

function blockFor(durationMs: number): void {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    // Deliberately block only this fixture process.
  }
}

function respond(message: unknown): void {
  if (parentPort) {
    parentPort.postMessage(message);
  } else {
    process.send?.(message);
  }
}

function handleMessage(value: unknown): void {
  const request = value as FixtureRequest;
  switch (request.method) {
    case "deleteFiles":
      if (request.payload.projectId === "block") {
        blockFor(1_000);
      }
      respond({ id: request.id, ok: true, result: null });
      break;
    case "ensureSemanticIndex":
      respond({
        error: {
          message: "fixture index failure",
          stack: "Error: fixture index failure\n    at sqlite-index-worker-fixture:1:1",
        },
        id: request.id,
        ok: false,
      });
      break;
    case "resolveSymbolGraph":
      process.exit(23);
      break;
    case "writeFileIndexBatch":
      // Keep the request pending so close() rejection is deterministic.
      break;
    default:
      respond({ id: request.id, ok: true, result: null });
  }
}

if (parentPort) {
  parentPort.on("message", handleMessage);
} else {
  process.on("message", handleMessage);
}
