import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { fileSnippetShape } from "../../core/validation/schemas.js";
import type { ToolDependencies } from "../toolRegistry.js";
import { readFileSnippet } from "../../core/project/fileSnippet.js";
import { asStructuredToolResponse, buildEnvelope } from "./responseEnvelope.js";

export function registerGetFileSnippetTool(server: McpServer, _dependencies: ToolDependencies): void {
  server.registerTool(
    "get_file_snippet",
    {
      description: "Read a range of lines from a project file.",
      inputSchema: fileSnippetShape,
      title: "Get File Snippet",
    },
    async ({ endLine, filePath, projectRootPath, startLine }) => {
      const result = await readFileSnippet(projectRootPath, filePath, startLine, endLine);
      const payload = buildEnvelope(
        { endLine, filePath, projectRootPath: result.projectRootPath, startLine },
        {
          filePath: result.filePath,
          projectRootPath: result.projectRootPath,
          snippet: result.snippet,
        },
        {
          snippet: {
            endLine: result.endLine,
            lineCount: result.endLine - result.startLine + 1,
            startLine: result.startLine,
          },
        },
      );
      return asStructuredToolResponse(payload);
    },
  );
}
