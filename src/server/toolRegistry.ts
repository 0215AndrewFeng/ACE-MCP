import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Logger } from "../core/common/logger.js";
import type { Settings } from "../core/common/types.js";
import type { ProjectRouter } from "../core/search/projectRouter.js";
import type { EmbeddingProvider } from "../core/search/embedding.js";
import { IndexCoordinator } from "../core/indexing/indexCoordinator.js";
import type { LlmClient } from "../core/llm/llmClient.js";
import { SearchService } from "../core/search/searchService.js";
import { SQLiteStore } from "../core/storage/sqliteStore.js";
import type { SummaryGenerator } from "../core/summary/summaryGenerator.js";
import { registerEvaluateSearchQualityTool } from "./tools/evaluateSearchQuality.js";
import { registerFindCalleesTool } from "./tools/findCallees.js";
import { registerFindCallersTool } from "./tools/findCallers.js";
import { registerFindDefinitionTool } from "./tools/findDefinition.js";
import { registerFindReferencesTool } from "./tools/findReferences.js";
import { registerGetFileSnippetTool } from "./tools/getFileSnippet.js";
import { registerIndexProjectTool } from "./tools/indexProject.js";
import { registerProjectStatsTool } from "./tools/projectStats.js";
import { registerSearchContextTool } from "./tools/searchContext.js";
import { registerCacheStatsTool } from "./tools/cacheStats.js";
import { registerClearProjectIndexTool } from "./tools/clearProjectIndex.js";
import { registerListSymbolsTool } from "./tools/listSymbols.js";
import { registerGenerateSummaryTool } from "./tools/generateSummary.js";
import { registerGetSummaryTool } from "./tools/getSummary.js";
import { registerAskCodebaseTool } from "./tools/askCodebase.js";
import { registerWarmIndexTool } from "./tools/warmIndex.js";
import { registerResolveProjectsTool } from "./tools/resolveProjects.js";

export interface ToolDependencies {
  embeddingProvider: EmbeddingProvider;
  indexCoordinator: IndexCoordinator;
  llmClient: LlmClient;
  logger: Logger;
  searchService: SearchService;
  settings: Settings;
  store: SQLiteStore;
  summaryGenerator: SummaryGenerator;
}

export interface ToolRegistryDependencies extends ToolDependencies {
  projectRouter: ProjectRouter;
}

export function registerTools(server: McpServer, dependencies: ToolRegistryDependencies): void {
  registerIndexProjectTool(server, dependencies);
  registerResolveProjectsTool(server, dependencies);
  registerSearchContextTool(server, dependencies);
  registerFindDefinitionTool(server, dependencies);
  registerFindReferencesTool(server, dependencies);
  registerFindCallersTool(server, dependencies);
  registerFindCalleesTool(server, dependencies);
  registerEvaluateSearchQualityTool(server, dependencies);
  registerGetFileSnippetTool(server, dependencies);
  registerProjectStatsTool(server, dependencies);
  registerCacheStatsTool(server, dependencies);
  registerClearProjectIndexTool(server, dependencies);
  registerListSymbolsTool(server, dependencies);
  registerGenerateSummaryTool(server, dependencies);
  registerGetSummaryTool(server, dependencies);
  registerAskCodebaseTool(server, dependencies);
  registerWarmIndexTool(server, dependencies);
}
