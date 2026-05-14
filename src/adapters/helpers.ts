import { buildStableId } from "../core/indexing/fileFingerprint.js";
import type { Language, SymbolInfo } from "../core/common/types.js";

export interface PatternDefinition {
  kind: SymbolInfo["kind"];
  pattern: RegExp;
}

const MAX_SIGNATURE_LENGTH = 240;

export function getLineNumber(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

export function buildQualifiedName(parts: string[]): string {
  return parts.filter(Boolean).join(".");
}

export function buildModulePath(relativePath: string, separator = "/"): string {
  const normalized = relativePath
    .replace(/\\/g, "/")
    .replace(/\.[^.]+$/, "")
    .replace(/\/index$/, "");
  return separator === "/" ? normalized : normalized.split("/").join(separator);
}

export function normalizeSignature(signature: string): string {
  const compact = signature.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_SIGNATURE_LENGTH ? compact : `${compact.slice(0, MAX_SIGNATURE_LENGTH - 3)}...`;
}

export function createSymbolInfo(params: {
  canonicalName?: string;
  containerName?: string;
  fileId: string;
  fullName?: string;
  kind: SymbolInfo["kind"];
  language: Language;
  line: number;
  modulePath?: string;
  name: string;
  signature: string;
}): SymbolInfo {
  const fullName = params.fullName ?? params.name;
  return {
    canonicalName: params.canonicalName ?? fullName,
    containerName: params.containerName,
    fileId: params.fileId,
    fullName,
    kind: params.kind,
    line: params.line,
    modulePath: params.modulePath,
    name: params.name,
    signature: normalizeSignature(params.signature),
    symbolId: buildStableId([params.fileId, params.language, params.kind, fullName, String(params.line)]),
  };
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

      symbols.push(createSymbolInfo({ fileId, kind: definition.kind, language, line, name, signature }));
    }
  }

  return symbols.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
}
