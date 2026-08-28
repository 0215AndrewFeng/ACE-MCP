import assert from "node:assert/strict";
import test from "node:test";

import { registerGenerateSummaryTool } from "./generateSummary.js";
import { registerListSymbolsTool } from "./listSymbols.js";

function captureTool(register: (server: never, dependencies: never) => void, dependencies: unknown) {
  let definition: any;
  let handler: ((input: any) => Promise<any>) | undefined;
  let name = "";
  const server = {
    registerTool(toolName: string, toolDefinition: unknown, toolHandler: (input: any) => Promise<any>) {
      name = toolName;
      definition = toolDefinition;
      handler = toolHandler;
    },
  };
  register(server as never, dependencies as never);
  assert.ok(handler);
  return { definition, handler: handler!, name };
}

test("generate_summary exposes and forwards forced refresh", async () => {
  let receivedOptions: unknown;
  const tool = captureTool(registerGenerateSummaryTool, {
    indexCoordinator: {
      ensureFreshIndex: async () => ({ projectId: "project-1", projectRootPath: "/repo" }),
    },
    summaryGenerator: {
      generateProjectSummary: async (_root: string, _id: string, options: unknown) => {
        receivedOptions = options;
        return {
          cachedModules: 0,
          durationMs: 1,
          filesWritten: ["project-summary.json"],
          forced: true,
          moduleCount: 1,
          outputDir: "/repo/.ace-mcp/summaries",
          regeneratedModules: 1,
          tokensUsed: { completion: 1, prompt: 1 },
        };
      },
    },
  });

  assert.equal(tool.name, "generate_summary");
  assert.ok(tool.definition.inputSchema.force);
  const response = await tool.handler({ force: true, projectRootPath: "/repo" });

  assert.deepEqual(receivedOptions, { force: true });
  assert.equal(response.structuredContent.data.forced, true);
  assert.equal(response.structuredContent.data.regeneratedModules, 1);
});

test("list_symbols enumerates definitions when no name pattern is supplied", async () => {
  let listArguments: unknown[] | undefined;
  const tool = captureTool(registerListSymbolsTool, {
    indexCoordinator: {
      ensureFreshIndex: async () => ({ projectId: "project-1", projectRootPath: "/repo" }),
    },
    store: {
      findDefinitions: () => {
        throw new Error("unfiltered listing must not use wildcard definition search");
      },
      listDefinitions: (...args: unknown[]) => {
        listArguments = args;
        return [{
          filePath: "src/index.ts",
          fullName: "RefundService",
          kind: "class",
          language: "javascript",
          line: 1,
          name: "RefundService",
          startLine: 1,
        }];
      },
    },
  });

  const response = await tool.handler({ limit: 20, pathPrefix: "src/", projectRootPath: "/repo" });

  assert.deepEqual(listArguments, ["project-1", 20, { pathPrefix: "src/" }]);
  assert.equal(response.structuredContent.data.count, 1);
  assert.equal(response.structuredContent.data.symbols[0].name, "RefundService");
});
