import { buildStableId } from "../core/indexing/fileFingerprint.js";
import type { Language, SymbolInfo } from "../core/common/types.js";

export interface PatternDefinition {
  kind: SymbolInfo["kind"];
  pattern: RegExp;
}

function getLineNumber(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

export function extractSymbolsWithPatterns(
  fileId: string,
  language: Language,
  content: string,
  patterns: PatternDefinition[],
): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  for (const definition of patterns) {
    for (const match of content.matchAll(definition.pattern)) {
      const name = match[1];
      const index = match.index ?? 0;
      const line = getLineNumber(content, index);
      const signature = match[0].trim();

      symbols.push({
        fileId,
        fullName: name,
        kind: definition.kind,
        line,
        name,
        signature,
        symbolId: buildStableId([fileId, language, definition.kind, name, String(line)]),
      });
    }
  }

  return symbols.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
}
