#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.resolve(scriptDir, "../dist/index.js");
const inputArgs = process.argv.slice(2);

function hasExplicitWebPort(args) {
  return args.some((arg) => arg === "--web-port" || arg.startsWith("--web-port="));
}

function buildArgs(args) {
  if (hasExplicitWebPort(args)) {
    return args;
  }

  const [first, ...rest] = args;
  const firstIsPort = first !== undefined && /^\d+$/.test(first);
  const port = firstIsPort ? first : process.env.ACE_MCP_WEB_PORT || "8787";
  return ["--web-port", port, ...(firstIsPort ? rest : args)];
}

const child = spawn(process.execPath, [entryPath, ...buildArgs(inputArgs)], {
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error(`Failed to start ace-mcp web panel: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
