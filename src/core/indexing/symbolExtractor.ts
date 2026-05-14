import { getLanguageAdapter } from "../../adapters/index.js";
import type { Language, SourceAnalysis, SymbolInfo } from "../common/types.js";

export function extractSymbols(fileId: string, language: Language, content: string): SymbolInfo[] {
  const adapter = getLanguageAdapter(language);
  return adapter?.extractSymbols(fileId, content) ?? [];
}

export function analyzeSource(fileId: string, relativePath: string, language: Language, content: string): SourceAnalysis {
  const adapter = getLanguageAdapter(language);
  if (adapter?.analyzeSource) {
    return adapter.analyzeSource(fileId, relativePath, content);
  }

  return {
    imports: [],
    symbols: adapter?.extractSymbols(fileId, content) ?? [],
    usages: [],
  };
}
