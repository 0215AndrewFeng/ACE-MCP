import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Logger } from "../core/common/logger.js";
import type { Settings } from "../core/common/types.js";
import { IndexCoordinator } from "../core/indexing/indexCoordinator.js";
import { SearchService } from "../core/search/searchService.js";
import { SQLiteStore } from "../core/storage/sqliteStore.js";
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

export interface ToolDependencies {
  indexCoordinator: IndexCoordinator;
  logger: Logger;
  searchService: SearchService;
  settings: Settings;
  store: SQLiteStore;
}

export function registerTools(server: McpServer, dependencies: ToolDependencies): void {
  registerIndexProjectTool(server, dependencies);
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
}
