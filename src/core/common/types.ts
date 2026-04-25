export type Language = "java" | "javascript" | "dotnet" | "python" | "unknown";
export type SupportedLanguage = Exclude<Language, "unknown">;
export type SearchMode = "auto" | "lexical" | "symbol" | "semantic" | "hybrid";
export type ProjectStatus = "ready" | "indexing" | "error";
export const DEFAULT_INCLUDE_CONTEXT_LINES = 0;
export const MAX_INCLUDE_CONTEXT_LINES = 50;

export interface Settings {
  batchSize: number;
  dataDir: string;
  databasePath: string;
  defaultTopK: number;
  excludePatterns: string[];
  logDir: string;
  logFilePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  maxFileSizeKb: number;
  maxLinesPerChunk: number;
  settingsFilePath: string;
  textExtensions: string[];
}

export interface CliOptions {
  help: boolean;
  version: boolean;
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
  fileId: string;
  fullName: string;
  kind: "class" | "enum" | "function" | "interface" | "method" | "record";
  line: number;
  name: string;
  signature: string;
  symbolId: string;
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
}

export interface QueryAnalysis {
  ftsQuery: string | null;
  hasIdentifierLikeSegments: boolean;
  isPathLike: boolean;
  isSymbolLike: boolean;
  rawQuery: string;
  semanticTerms: string[];
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
  indexing?: IndexEventSummary;
  projectRootPath: string;
  query: string;
  resultMode: SearchResultMode;
  results: SearchResult[];
  stats: {
    indexedFiles: number;
    scannedFiles: number;
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
  embedding: number[];
  modelName: string;
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
