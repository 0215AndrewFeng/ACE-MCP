export type Language = "java" | "javascript" | "dotnet" | "python" | "unknown";
export type SupportedLanguage = Exclude<Language, "unknown">;
export type SearchMode = "auto" | "lexical" | "symbol" | "hybrid";
export type ProjectStatus = "ready" | "indexing" | "error";

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
  deletedFiles: number;
  indexedFiles: number;
  project: ProjectInfo;
  projectId: string;
  projectRootPath: string;
  scannedFiles: number;
}

export interface QueryAnalysis {
  ftsQuery: string | null;
  isPathLike: boolean;
  isSymbolLike: boolean;
  rawQuery: string;
  tokens: string[];
}

export interface SearchResult {
  endLine: number;
  filePath: string;
  language: Language;
  reason: string;
  score: number;
  snippet: string;
  startLine: number;
  symbol?: string;
}

export interface SearchResponse {
  projectRootPath: string;
  query: string;
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

export interface SearchContextInput {
  includeContextLines?: number;
  mode?: SearchMode;
  projectRootPath: string;
  query: string;
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
