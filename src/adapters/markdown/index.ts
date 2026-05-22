import type { LanguageAdapter, SourceAnalysis } from "../../core/common/types.js";

const emptyAnalysis: SourceAnalysis = {
  imports: [],
  symbols: [],
  usages: [],
};

export const markdownAdapter: LanguageAdapter = {
  analyzeSource(_fileId, _relativePath, _content) {
    return emptyAnalysis;
  },
  extractSymbols(_fileId, _content) {
    return [];
  },
  language: "markdown",
  projectMarkerPatterns: [],
  sourceExtensions: [".md", ".mdx"],
};
