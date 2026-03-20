import { getLanguageAdapter } from "../../adapters/index.js";
import type { Language, SymbolInfo } from "../common/types.js";

export function extractSymbols(fileId: string, language: Language, content: string): SymbolInfo[] {
  const adapter = getLanguageAdapter(language);
  return adapter?.extractSymbols(fileId, content) ?? [];
}
