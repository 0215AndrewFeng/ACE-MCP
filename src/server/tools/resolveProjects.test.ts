import assert from "node:assert/strict";
import test from "node:test";

import { registerResolveProjectsTool } from "./resolveProjects.js";

test("resolve_projects exposes project routing without indexing projects", async () => {
  let registeredName = "";
  let handler: ((input: { query: string; topK: number }) => Promise<any>) | undefined;
  const server = {
    registerTool(
      name: string,
      _definition: unknown,
      registeredHandler: (input: { query: string; topK: number }) => Promise<any>,
    ) {
      registeredName = name;
      handler = registeredHandler;
    },
  };
  const resolution = {
    candidates: [
      {
        confidence: 0.91,
        evidence: [{ filePath: "src/FlowSwitcher.ts", matchedTerms: ["flowswitcher"], source: "symbol" }],
        matchedTerms: ["flowswitcher"],
        projectRootPath: "/work/change-service",
        score: 1.4,
      },
    ],
    decision: "single" as const,
    durationMs: 8,
    query: "FlowSwitcher",
    selectedProjectRootPaths: ["/work/change-service"],
  };
  const dependencies = {
    indexCoordinator: {
      ensureFreshIndex: () => {
        throw new Error("resolve_projects must not index every project");
      },
    },
    projectRouter: {
      resolve: async (query: string, options: { topK: number }) => {
        assert.equal(query, "FlowSwitcher");
        assert.equal(options.topK, 2);
        return resolution;
      },
    },
  };

  registerResolveProjectsTool(server as never, dependencies as never);
  assert.equal(registeredName, "resolve_projects");
  assert.ok(handler);

  const response = await handler!({ query: "FlowSwitcher", topK: 2 });
  assert.deepEqual(response.structuredContent.data, resolution);
  assert.deepEqual(response.structuredContent.request, { query: "FlowSwitcher", topK: 2 });
  assert.equal(response.structuredContent.stats.routing.candidateCount, 1);
});
