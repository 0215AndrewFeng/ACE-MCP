import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools, type ToolRegistryDependencies } from "./toolRegistry.js";
import { APP_NAME, APP_VERSION } from "../version.js";

export function createMcpServer(dependencies: ToolRegistryDependencies): McpServer {
  const server = new McpServer({
    name: APP_NAME,
    version: APP_VERSION,
  });

  registerTools(server, dependencies);
  return server;
}
