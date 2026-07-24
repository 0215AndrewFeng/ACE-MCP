import type { AppRuntimeInfo, Settings } from "../core/common/types.js";
import type { Logger } from "../core/common/logger.js";
import type { EmbeddingProvider } from "../core/search/embedding.js";
import type { IndexCoordinator } from "../core/indexing/indexCoordinator.js";
import type { LlmClient } from "../core/llm/llmClient.js";
import type { SearchService } from "../core/search/searchService.js";
import type { ProjectRouter } from "../core/search/projectRouter.js";
import type { SQLiteStore } from "../core/storage/sqliteStore.js";
import type { SummaryGenerator } from "../core/summary/summaryGenerator.js";
import type { LongTaskTracker } from "../core/tasks/longTaskTracker.js";

export interface WebAppDependencies {
  embeddingProvider: EmbeddingProvider;
  indexCoordinator: IndexCoordinator;
  llmClient: LlmClient;
  logger: Logger;
  longTaskTracker?: LongTaskTracker;
  projectRouter?: ProjectRouter;
  runtime: AppRuntimeInfo;
  searchService: SearchService;
  settings: Settings;
  store: SQLiteStore;
  summaryGenerator: SummaryGenerator;
}

export interface WebAppHandle {
  close: () => Promise<void>;
  port: number;
}
