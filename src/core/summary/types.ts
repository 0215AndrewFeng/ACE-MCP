export interface SymbolSummary {
  name: string;
  kind: string;
  responsibility: string;
  signature: string;
}

export interface FileSummary {
  relativePath: string;
  symbols: SymbolSummary[];
}

export interface ModuleSummary {
  path: string;
  description: string;
  keySymbols: string[];
  fileCount: number;
  /** v4.2.5: Content hash for incremental update detection */
  contentHash?: string;
}

export interface ModuleRelationship {
  from: string;
  to: string;
  kind: "imports" | "extends" | "implements" | "calls";
}

export interface ProjectSummary {
  version: number;
  generatedAt: string;
  projectRootPath: string;
  architecture: string;
  modules: ModuleSummary[];
  relationships: ModuleRelationship[];
  tokensUsed: { prompt: number; completion: number };
}

export interface SummaryGenerationResult {
  outputDir: string;
  filesWritten: string[];
  moduleCount: number;
  tokensUsed: { prompt: number; completion: number };
  durationMs: number;
  /** v4.2.5: Number of modules regenerated (vs cached) */
  regeneratedModules?: number;
  cachedModules?: number;
  forced?: boolean;
}

export interface SummaryGenerationOptions {
  force?: boolean;
}
