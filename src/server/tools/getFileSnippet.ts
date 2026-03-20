import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolDependencies } from "../toolRegistry.js";
import { readFileSnippet } from "../../core/project/fileSnippet.js";

export function registerGetFileSnippetTool(server: McpServer, _dependencies: ToolDependencies): void {
  server.registerTool(
    "get_file_snippet",
    {
      description: "Read a range of lines from a project file.",
      inputSchema: {
        endLine: z.number().int().min(1),
        filePath: z.string().min(1),
        projectRootPath: z.string().min(1),
        startLine: z.number().int().min(1),
      },
      title: "Get File Snippet",
    },
    async ({ endLine, filePath, projectRootPath, startLine }) => {
      const result = await readFileSnippet(projectRootPath, filePath, startLine, endLine);

      return {
        content: [
          {
            text: JSON.stringify(result, null, 2),
            type: "text",
          },
        ],
      };
    },
  );
}
