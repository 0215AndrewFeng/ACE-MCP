export type Language = "java" | "javascript" | "dotnet" | "python" | "markdown" | "unknown";
export type SupportedLanguage = Exclude<Language, "unknown">;
export type SearchMode = "auto" | "lexical" | "symbol" | "semantic" | "hybrid";
export type StructuredSearchField = "content" | "path" | "symbol";
export type StructuredSearchOperator = "AND" | "OR" | "NOT";
export type ProjectStatus = "ready" | "indexing" | "error";
export type VectorIndexingMode = "lazy" | "eager";
export type IndexFreshnessPolicy = "always" | "stale" | "manual";
export type ContextMode = "chunk" | "merged-file" | "full-file";
export const DEFAULT_INCLUDE_CONTEXT_LINES = 0;
export const MAX_INCLUDE_CONTEXT_LINES = 50;
export const DEFAULT_CALL_GRAPH_DEPTH = 1;
export const MAX_CALL_GRAPH_DEPTH = 5;

export type EmbeddingProviderType = "memory" | "remote";

export interface Settings {
  autoWatch: boolean;
  batchSize: number;
  dataDir: string;
  databasePath: string;
  defaultTopK: number;
  embeddingApiKey: string;
  embeddingApiUrl: string;
  embeddingModel: string;
  embeddingProvider: EmbeddingProviderType;
  enableVectorSearch: boolean;
  excludePatterns: string[];
  logDir: string;
  logFilePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  maxFileSizeKb: number;
  maxLinesPerChunk: number;
  settingsFilePath: string;
  textExtensions: string[];
  vectorIndexingMode: VectorIndexingMode;
  indexFreshness: IndexFreshnessPolicy;
  indexFreshnessSeconds: number;
  searchCacheTtlMs: number;
  searchCacheMaxSize: number;
  vectorCacheMaxProjects: number;
  searchFanoutLimit: number;
  llmApiUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmMaxTokens: number;
  llmTemperature: number;
  enableLlmReranker: boolean;
  llmRerankerMaxCandidates: number;
  // v4.3.6: Ask Codebase limits (configurable)
  qaMaxSourcesDefault: number;
  qaMaxSourcesMax: number;
  qaMaxContextTokens: number;
  qaMaxContextTokensMax: number;
  // v4.3.6: Search limits (configurable)
  searchPerFileLimit: number;
  searchFanoutMultiplier: number;
}

export interface CliOptions {
  doctor: boolean;
  evalPath?: string;
  help: boolean;
  version: boolean;
  warm: boolean;
  webPort?: number;
}

export interface AppRuntimeInfo {
  nodeVersion: string;
  pid: number;
  startedAt: string;
  version: string;
  webPort?: number;
}

export interface LanguageAdapter {
  analyzeSource?: (fileId: string, relativePath: string, content: string) => SourceAnalysis;
  extractSymbols(fileId: string, content: string): SymbolInfo[];
  language: SupportedLanguage;
  projectMarkerPatterns: RegExp[];
  sourceExtensions: string[];
}

export interface ProjectInfo {
  languages: Language[];
  markers: string[];
  projectType: "single-language" | "mixed";
  rootPath: string;
}

export interface CollectedFile {
  absolutePath: string;
  language: Language;
  mtimeMs: number;
  relativePath: string;
  size: number;
}

export interface IndexedFileRecord {
  encoding: string;
  fileId: string;
  language: Language;
  lineCount: number;
  mtimeMs: number;
  relativePath: string;
  sha256: string;
  size: number;
}

export interface ChunkRecord {
  chunkId: string;
  content: string;
  endLine: number;
  fileId: string;
  startLine: number;
  symbolNames: string[];
}

export interface SymbolInfo {
  canonicalName?: string;
  containerName?: string;
  fileId: string;
  fullName: string;
  kind: "class" | "constructor" | "enum" | "field" | "function" | "interface" | "method" | "property" | "record";
  line: number;
  modulePath?: string;
  name: string;
  signature: string;
  symbolId: string;
}

export type SymbolUsageKind = "call" | "import" | "instantiation" | "type" | "usage";

export interface ImportInfo {
  alias: string;
  importedName: string;
  line: number;
  sourceModule: string;
}

export interface SymbolUsageInfo {
  candidateNames: string[];
  kind: SymbolUsageKind;
  line: number;
  ownerSymbol?: string;
  rawName: string;
}

export interface SourceAnalysis {
  imports: ImportInfo[];
  symbols: SymbolInfo[];
  usages: SymbolUsageInfo[];
}

export interface IndexProjectResult {
  changedFiles: number;
  chunkCount: number;
  createdAt: string;
  deletedFiles: number;
  failedFileCount: number;
  failedFiles: IndexFailure[];
  indexedFiles: number;
  project: ProjectInfo;
  projectId: string;
  projectRootPath: string;
  scannedFiles: number;
  timings: IndexTimingStats;
  vectorIndex: IndexVectorStats;
}

export interface IndexFailure {
  filePath: string;
  message: string;
}

export interface IndexEventSummary {
  changedFiles: number;
  chunkCount: number;
  createdAt: string;
  deletedFiles: number;
  failedFileCount: number;
  failedFiles: IndexFailure[];
  indexedFiles: number;
  scannedFiles: number;
  timings: IndexTimingStats;
  vectorIndex: IndexVectorStats;
}

export interface QueryAnalysis {
  ftsQuery: string | null;
  hasIdentifierLikeSegments: boolean;
  identifiers: string[];       // v4.5.1: camelCase/snake_case/PascalCase identifiers extracted from query
  isPathLike: boolean;
  isSymbolLike: boolean;
  naturalLanguage: string[];   // v4.5.1: non-identifier tokens (CJK words, plain English)
  rawQuery: string;
  semanticTerms: string[];
  structuredQuery?: {
    fields: StructuredSearchField[];
    isStructured: boolean;
    operators: StructuredSearchOperator[];
    originalQuery: string;
    termCount: number;
  };
  tokens: string[];
}

export type SearchMatchSource = "lexical" | "path" | "symbol" | "semantic";
export type SearchResultMode = "full" | "metadata";

export interface SearchResultExplanation {
  matchedSources: SearchMatchSource[];
  matchedTokens: string[];
  multiSource?: boolean;
  pathMatch?: "basename" | "boundary" | "exact" | "prefix" | "suffix";
  snippetMatch?: "query";
  symbolMatch?: "boundary" | "exact" | "qualified-suffix";
  tokenCoverage?: {
    matched: number;
    total: number;
  };
}

export interface SearchResult {
  /** v4.2.3: chunk ID for candidate prefiltering in vector search */
  chunkId?: string;
  endLine: number;
  explanation?: SearchResultExplanation;
  filePath: string;
  language: Language;
  reason: string;
  score: number;
  snippet: string;
  snippetIncluded: boolean;
  startLine: number;
  symbol?: string;
}

export interface SearchFilters {
  excludePathPrefix?: string;
  languages?: SupportedLanguage[];
  pathContains?: string;
  pathPrefix?: string;
}

export interface SearchResponse {
  diagnostics: SearchDiagnostics;
  indexing?: IndexEventSummary;
  notes: string[];
  projectRootPath: string;
  query: string;
  resultMode: SearchResultMode;
  results: SearchResult[];
  stats: {
    indexedFiles: number;
    resultCount: number;
    scannedFiles: number;
    searchMs: number;
  };
}

export interface DefinitionMatch {
  canonicalName?: string;
  endLine: number;
  filePath: string;
  fullName: string;
  kind: SymbolInfo["kind"];
  language: Language;
  line: number;
  modulePath?: string;
  name: string;
  score: number;
  signature: string;
  snippet: string;
  snippetIncluded: boolean;
  startLine: number;
  symbolId: string;
}

export interface DefinitionSearchResponse {
  notes: string[];
  projectRootPath: string;
  query: string;
  resultMode: SearchResultMode;
  results: DefinitionMatch[];
  stats: {
    resultCount: number;
    searchMs: number;
  };
}

export interface ReferenceSearchResponse {
  definition: DefinitionMatch | null;
  definitions: DefinitionMatch[];
  notes: string[];
  projectRootPath: string;
  query: string;
  resultMode: SearchResultMode;
  results: SearchResult[];
  stats: {
    definitionCount: number;
    referenceCount: number;
    searchMs: number;
  };
}

export interface CallGraphMatch {
  callKind: SymbolUsageKind;
  endLine: number;
  filePath: string;
  hopCount: number;
  language: Language;
  line: number;
  ownerSymbol?: string;
  rawName: string;
  resolvedSymbol?: string;
  score: number;
  snippet: string;
  snippetIncluded: boolean;
  startLine: number;
  symbolPath: string[];
}

export interface CallGraphSearchResponse {
  definition: DefinitionMatch | null;
  definitions: DefinitionMatch[];
  direction: "callers" | "callees";
  notes: string[];
  projectRootPath: string;
  query: string;
  resultMode: SearchResultMode;
  results: CallGraphMatch[];
  stats: {
    depthReached: number;
    depthRequested: number;
    definitionCount: number;
    resultCount: number;
    searchMs: number;
  };
}

export interface ProjectStats {
  chunkCount: number;
  fileCount: number;
  languages: Language[];
  lastIndexAt: string | null;
  latestIndexEvent: IndexEventSummary | null;
  lastScanAt: string | null;
  projectRootPath: string;
  status: ProjectStatus;
  symbolCount: number;
}

export interface IndexTimingStats {
  collectMs: number;
  detectMs: number;
  indexMs: number;
  totalMs: number;
  vectorMs: number;
}

export interface IndexVectorStats {
  enabled: boolean;
  hydratedChunkCount: number;
  mode: VectorIndexingMode;
}

export interface ProjectListItem {
  languages: Language[];
  lastIndexAt: string | null;
  lastScanAt: string | null;
  projectRootPath: string;
  status: ProjectStatus;
}

// Vector embedding types
export interface VectorEntry {
  chunkId: string;
  embedding: Float32Array;
  filePath: string;
  language: Language;
  modelName: string;
}

export interface SearchPhaseStat {
  candidateCount: number;
  durationMs: number;
  error?: string;
  name: string;
  reason?: string;
  skipped?: boolean;
  timedOut?: boolean;
}

/**
 * Search budget controls how much time each phase of search can take.
 * When a phase exceeds its budget, it will be terminated early and
 * the search will continue with results from faster phases.
 */
export interface SearchBudget {
  /** Total search time budget in milliseconds (default: 30000) */
  totalMs: number;
  /** Vector search phase budget in milliseconds (default: 10000) */
  vectorMs: number;
  /** FTS/lexical phase budget in milliseconds (default: 5000) */
  ftsMs: number;
  /** Symbol search phase budget in milliseconds (default: 3000) */
  symbolMs: number;
}

export const DEFAULT_SEARCH_BUDGET: SearchBudget = {
  totalMs: 600_000,
  vectorMs: 200_000,
  ftsMs: 100_000,
  symbolMs: 60_000,
};

export interface SearchDiagnostics {
  candidateCount: number;
  executedStrategies: SearchPhaseStat[];
  queryAnalysis: QueryAnalysis;
  resultSourceBreakdown: Partial<Record<SearchMatchSource, number>>;
  vectorIndex: {
    cacheHit: boolean;
    candidateCount: number;
    enabled: boolean;
    hydratedChunkCount: number;
    mode: VectorIndexingMode;
    /** True if vector search was skipped because vectors weren't ready */
    skippedNoVectors?: boolean;
    /** v4.2.3: True if vector search used FTS results as candidate set */
    prefiltered?: boolean;
    /** v4.2.3: Number of candidates in the prefiltered set */
    prefilteredCandidates?: number;
  };
  /** Budget tracking for search phases */
  budget?: {
    totalMs: number;
    usedMs: number;
    timedOutPhases: string[];
  };
}

export interface SearchContextInput {
  excludePathPrefix?: string;
  includeContextLines?: number;
  languages?: SupportedLanguage[];
  mode?: SearchMode;
  pathContains?: string;
  pathPrefix?: string;
  projectRootPath: string;
  query: string;
  resultMode?: SearchResultMode;
  topK?: number;
}

export interface FindDefinitionInput {
  excludePathPrefix?: string;
  includeContextLines?: number;
  languages?: SupportedLanguage[];
  pathContains?: string;
  pathPrefix?: string;
  projectRootPath: string;
  query: string;
  resultMode?: SearchResultMode;
  topK?: number;
}

export interface FindReferencesInput {
  excludePathPrefix?: string;
  includeContextLines?: number;
  languages?: SupportedLanguage[];
  pathContains?: string;
  pathPrefix?: string;
  projectRootPath: string;
  query: string;
  resultMode?: SearchResultMode;
  topK?: number;
}

export interface FindCallGraphInput {
  depth?: number;
  excludePathPrefix?: string;
  includeContextLines?: number;
  languages?: SupportedLanguage[];
  pathContains?: string;
  pathPrefix?: string;
  projectRootPath: string;
  query: string;
  resultMode?: SearchResultMode;
  topK?: number;
}

export interface SearchQualityCaseInput {
  excludePathPrefix?: string;
  expectedFiles?: string[];
  expectedTopFile?: string;
  languages?: SupportedLanguage[];
  mode?: SearchMode;
  name: string;
  pathContains?: string;
  pathPrefix?: string;
  query: string;
  topK?: number;
}

export interface SearchQualityCaseResult {
  actualFiles: string[];
  expectedFiles: string[];
  expectedTopFile?: string;
  firstRelevantRank?: number;
  mode: SearchMode;
  name: string;
  passed: boolean;
  query: string;
  reasons: string[];
  topFile?: string;
}

export interface SearchQualityEvaluation {
  cases: SearchQualityCaseResult[];
  projectRootPath: string;
  summary: {
    failed: number;
    meanReciprocalRank: number;
    passRate: number;
    passed: number;
    top1Recall: number;
    top5Recall: number;
    total: number;
  };
}

export interface IndexProjectInput {
  mode?: "full" | "incremental";
  projectRootPath: string;
}

export interface GetFileSnippetInput {
  endLine: number;
  filePath: string;
  projectRootPath: string;
  startLine: number;
}

export interface ProjectStatsInput {
  projectRootPath: string;
}

export interface EvaluateSearchQualityInput {
  cases: SearchQualityCaseInput[];
  projectRootPath: string;
}
