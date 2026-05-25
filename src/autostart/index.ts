/**
 * Auto-start management for ace-mcp service.
 * - macOS: Uses launchd (~/Library/LaunchAgents)
 * - Linux: Uses systemd user service (~/.config/systemd/user)
 */

import { exec } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const SERVICE_NAME = "com.ace-mcp.server";
const SYSTEMD_SERVICE_NAME = "ace-mcp";

interface AutostartConfig {
  enabled: boolean;
  webPort?: number;
}

/**
 * Get the path to the ace-mcp executable
 */
function getExecutablePath(): string {
  // When installed globally via npm, use the bin name
  // When running from source, use node + dist/index.js
  // import.meta.dirname is .../dist/autostart, go up to project root, then dist/index.js
  const distPath = path.resolve(import.meta.dirname, "../index.js");
  return distPath;
}

/**
 * Generate macOS launchd plist content
 */
function generateLaunchdPlist(config: AutostartConfig): string {
  const execPath = getExecutablePath();
  const nodePath = process.execPath;
  const logDir = path.join(os.homedir(), ".ace-mcp", "log");

  const args = [nodePath, execPath];
  if (config.webPort) {
    args.push("--web-port", String(config.webPort));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((arg) => `        <string>${arg}</string>`).join("\n")}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logDir}/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/launchd-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
`;
}

/**
 * Generate Linux systemd service content
 */
function generateSystemdService(config: AutostartConfig): string {
  const execPath = getExecutablePath();
  const nodePath = process.execPath;

  let execStart = `${nodePath} ${execPath}`;
  if (config.webPort) {
    execStart += ` --web-port ${config.webPort}`;
  }

  return `[Unit]
Description=ace-mcp - Local code search MCP server
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

/**
 * Check if current process is running under launchd (started by launchctl)
 */
function isRunningUnderLaunchd(): boolean {
  // If LAUNCHED_BY_LAUNCHD is set, or parent process is launchd (pid 1)
  // A simpler heuristic: check if we're already in launchctl list
  return process.ppid === 1;
}

/**
 * Enable autostart on macOS
 */
async function enableMacOS(config: AutostartConfig): Promise<void> {
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${SERVICE_NAME}.plist`);
  const logDir = path.join(os.homedir(), ".ace-mcp", "log");

  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  // Check if we're being called from within the launchd-managed service
  const runningUnderLaunchd = isRunningUnderLaunchd();

  if (!runningUnderLaunchd) {
    // Unload existing service if present (only when called from CLI, not from running service)
    try {
      await execAsync(`launchctl unload "${plistPath}" 2>/dev/null`);
    } catch {
      // Ignore if not loaded
    }
  }

  // Write plist file
  await writeFile(plistPath, generateLaunchdPlist(config), "utf8");

  if (!runningUnderLaunchd) {
    // Load the service (only when called from CLI)
    await execAsync(`launchctl load "${plistPath}"`);
  }
  // If running under launchd, just update the plist - changes take effect on next restart
}

/**
 * Disable autostart on macOS
 */
async function disableMacOS(): Promise<void> {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_NAME}.plist`);

  // Check if we're being called from within the launchd-managed service
  const runningUnderLaunchd = isRunningUnderLaunchd();

  if (!runningUnderLaunchd) {
    // Only unload if called from CLI, not from running service
    try {
      await execAsync(`launchctl unload "${plistPath}" 2>/dev/null`);
    } catch {
      // Ignore if not loaded
    }
  }

  try {
    await rm(plistPath);
  } catch {
    // Ignore if not exists
  }
  // If running under launchd, the service keeps running until manually stopped or system restart
}

/**
 * Check autostart status on macOS
 */
async function statusMacOS(): Promise<{ enabled: boolean; running: boolean; webPort?: number }> {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_NAME}.plist`);

  let enabled = false;
  let webPort: number | undefined;

  try {
    const content = await readFile(plistPath, "utf8");
    enabled = true;

    // Parse webPort from plist
    const portMatch = content.match(/--web-port<\/string>\s*<string>(\d+)<\/string>/);
    if (portMatch) {
      webPort = Number(portMatch[1]);
    }
  } catch {
    // File not found = not enabled
  }

  let running = false;
  try {
    const { stdout } = await execAsync(`launchctl list | grep "${SERVICE_NAME}"`);
    running = stdout.includes(SERVICE_NAME);
  } catch {
    // Not running
  }

  return { enabled, running, webPort };
}

/**
 * Enable autostart on Linux
 */
async function enableLinux(config: AutostartConfig): Promise<void> {
  const systemdDir = path.join(os.homedir(), ".config", "systemd", "user");
  const servicePath = path.join(systemdDir, `${SYSTEMD_SERVICE_NAME}.service`);

  await mkdir(systemdDir, { recursive: true });

  // Write service file
  await writeFile(servicePath, generateSystemdService(config), "utf8");

  // Reload systemd and enable service
  await execAsync("systemctl --user daemon-reload");
  await execAsync(`systemctl --user enable ${SYSTEMD_SERVICE_NAME}`);
  await execAsync(`systemctl --user start ${SYSTEMD_SERVICE_NAME}`);
}

/**
 * Disable autostart on Linux
 */
async function disableLinux(): Promise<void> {
  const servicePath = path.join(os.homedir(), ".config", "systemd", "user", `${SYSTEMD_SERVICE_NAME}.service`);

  try {
    await execAsync(`systemctl --user stop ${SYSTEMD_SERVICE_NAME}`);
  } catch {
    // Ignore if not running
  }

  try {
    await execAsync(`systemctl --user disable ${SYSTEMD_SERVICE_NAME}`);
  } catch {
    // Ignore if not enabled
  }

  try {
    await rm(servicePath);
    await execAsync("systemctl --user daemon-reload");
  } catch {
    // Ignore if not exists
  }
}

/**
 * Check autostart status on Linux
 */
async function statusLinux(): Promise<{ enabled: boolean; running: boolean; webPort?: number }> {
  const servicePath = path.join(os.homedir(), ".config", "systemd", "user", `${SYSTEMD_SERVICE_NAME}.service`);

  let enabled = false;
  let webPort: number | undefined;

  try {
    const content = await readFile(servicePath, "utf8");
    enabled = true;

    // Parse webPort from service file
    const portMatch = content.match(/--web-port\s+(\d+)/);
    if (portMatch) {
      webPort = Number(portMatch[1]);
    }
  } catch {
    // File not found = not enabled
  }

  let running = false;
  try {
    const { stdout } = await execAsync(`systemctl --user is-active ${SYSTEMD_SERVICE_NAME} 2>/dev/null`);
    running = stdout.trim() === "active";
  } catch {
    // Not running
  }

  return { enabled, running, webPort };
}

/**
 * Enable autostart
 */
export async function enableAutostart(config: AutostartConfig = { enabled: true }): Promise<void> {
  const platform = os.platform();

  if (platform === "darwin") {
    await enableMacOS(config);
  } else if (platform === "linux") {
    await enableLinux(config);
  } else {
    throw new Error(`Autostart not supported on ${platform}. Use Windows Task Scheduler or your system's startup manager.`);
  }
}

/**
 * Disable autostart
 */
export async function disableAutostart(): Promise<void> {
  const platform = os.platform();

  if (platform === "darwin") {
    await disableMacOS();
  } else if (platform === "linux") {
    await disableLinux();
  } else {
    throw new Error(`Autostart not supported on ${platform}.`);
  }
}

/**
 * Get autostart status
 */
export async function getAutostartStatus(): Promise<{ enabled: boolean; running: boolean; webPort?: number; platform: string }> {
  const platform = os.platform();

  if (platform === "darwin") {
    return { ...await statusMacOS(), platform: "macOS (launchd)" };
  } else if (platform === "linux") {
    return { ...await statusLinux(), platform: "Linux (systemd)" };
  } else {
    return { enabled: false, running: false, platform: `${platform} (not supported)` };
  }
}
