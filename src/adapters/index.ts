import path from "node:path";

import type { Language, LanguageAdapter, SupportedLanguage } from "../core/common/types.js";
import { dotnetAdapter } from "./dotnet/index.js";
import { javaAdapter } from "./java/index.js";
import { javascriptAdapter } from "./javascript/index.js";
import { markdownAdapter } from "./markdown/index.js";
import { pythonAdapter } from "./python/index.js";

const ADAPTERS: LanguageAdapter[] = [javaAdapter, javascriptAdapter, dotnetAdapter, pythonAdapter, markdownAdapter];

const ADAPTERS_BY_LANGUAGE = new Map<SupportedLanguage, LanguageAdapter>(
  ADAPTERS.map((adapter) => [adapter.language, adapter]),
);

export function detectLanguagesFromRootEntries(entryNames: string[]): {
  languages: SupportedLanguage[];
  matchedMarkers: string[];
} {
  const languages = new Set<SupportedLanguage>();
  const matchedMarkers = new Set<string>();

  for (const entryName of entryNames) {
    for (const adapter of ADAPTERS) {
      if (adapter.projectMarkerPatterns.some((pattern) => pattern.test(entryName))) {
        languages.add(adapter.language);
        matchedMarkers.add(entryName);
      }
    }
  }

  return {
    languages: [...languages].sort(),
    matchedMarkers: [...matchedMarkers].sort(),
  };
}

export function getLanguageAdapter(language: Language): LanguageAdapter | null {
  if (language === "unknown") {
    return null;
  }

  return ADAPTERS_BY_LANGUAGE.get(language) ?? null;
}

export function inferLanguageFromFilePath(filePath: string): Language {
  const extension = path.extname(filePath).toLowerCase();
  const adapter = ADAPTERS.find((item) => item.sourceExtensions.includes(extension));
  return adapter?.language ?? "unknown";
}

export function listLanguageAdapters(): LanguageAdapter[] {
  return [...ADAPTERS];
}
