import type { CliOptions } from "../core/common/types.js";
import { APP_NAME } from "../version.js";

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

export type AutostartAction = "enable" | "disable" | "status";

export function shouldStartAutomaticUpdates(options: Pick<CliOptions, "webPort">): boolean {
  return options.webPort !== undefined;
}

export function parseCliArgs(argv: string[]): CliOptions & { autostart?: AutostartAction } {
  let webPort: number | undefined;
  let help = false;
  let version = false;
  let warm = false;
  let doctor = false;
  let autostart: AutostartAction | undefined;
  let evalPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }

    if (arg === "--warm") {
      warm = true;
      continue;
    }

    if (arg === "--doctor") {
      doctor = true;
      continue;
    }

    if (arg === "--web-port") {
      webPort = parsePort(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--web-port=")) {
      webPort = parsePort(arg.slice("--web-port=".length));
      continue;
    }

    if (arg === "--eval") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing --eval value: expected a path to a JSON case file");
      }
      evalPath = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--eval=")) {
      const value = arg.slice("--eval=".length);
      if (!value) {
        throw new Error("Missing --eval value: expected a path to a JSON case file");
      }
      evalPath = value;
      continue;
    }

    if (arg === "--autostart") {
      const action = argv[index + 1];
      if (action === "enable" || action === "disable" || action === "status") {
        autostart = action;
        index += 1;
      } else {
        throw new Error(`Invalid --autostart value: ${action}. Must be 'enable', 'disable', or 'status'.`);
      }
      continue;
    }

    if (arg.startsWith("--autostart=")) {
      const action = arg.slice("--autostart=".length);
      if (action === "enable" || action === "disable" || action === "status") {
        autostart = action;
      } else {
        throw new Error(`Invalid --autostart value: ${action}. Must be 'enable', 'disable', or 'status'.`);
      }
    }
  }

  return { doctor, evalPath, help, version, warm, webPort, autostart };
}

export function formatHelpText(): string {
  return [
    APP_NAME,
    "",
    "Usage:",
    "  node dist/index.js [--web-port 8787] [--warm] [--doctor] [--eval <caseFile>] [--autostart enable|disable|status] [--version]",
    "",
    "Options:",
    "  --warm                     Warm up previously-indexed projects on startup",
    "  --doctor                   Check local install health, dependencies, storage, and config",
    "  --web-port <port>          Start the HTTP debug panel on the specified port",
    "  --eval <caseFile>          Run search-quality evaluation against a JSON golden-case",
    "                             file, print a report, then exit (0 = pass, 1 = fail)",
    "  --autostart <action>       Manage autostart on system boot:",
    "                               enable  - Enable autostart (uses current --web-port)",
    "                               disable - Disable autostart",
    "                               status  - Show current autostart status",
    "  -v, --version              Show version",
    "  -h, --help                 Show help",
    "",
    "Autostart:",
    "  macOS: Uses launchd (~/Library/LaunchAgents)",
    "  Linux: Uses systemd user service (~/.config/systemd/user)",
    "",
    "Examples:",
    "  # Enable autostart with web panel on port 8787",
    "  node dist/index.js --autostart enable --web-port 8787",
    "",
    "  # Check autostart status",
    "  node dist/index.js --autostart status",
    "",
    "  # Disable autostart",
    "  node dist/index.js --autostart disable",
  ].join("\n");
}
