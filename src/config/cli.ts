import type { CliOptions } from "../core/common/types.js";

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --web-port value: ${value}`);
  }

  return port;
}

export function parseCliArgs(argv: string[]): CliOptions {
  let webPort: number | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--web-port") {
      webPort = parsePort(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--web-port=")) {
      webPort = parsePort(arg.slice("--web-port=".length));
    }
  }

  return { help, webPort };
}

export function formatHelpText(): string {
  return [
    "ace-mcp",
    "",
    "Usage:",
    "  node dist/index.js [--web-port 8787]",
    "",
    "Options:",
    "  --web-port <port>   Start the HTTP debug panel on the specified port",
    "  -h, --help          Show help",
  ].join("\n");
}
