import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools, type ToolDependencies } from "./toolRegistry.js";

export function createMcpServer(dependencies: ToolDependencies): McpServer {
  const server = new McpServer({
    name: "ace-mcp",
    version: "2.0.0",
  });

  registerTools(server, dependencies);
  return server;
}
