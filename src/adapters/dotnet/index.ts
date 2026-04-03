import type { LanguageAdapter } from "../../core/common/types.js";
import { buildQualifiedName, createSymbolInfo } from "../helpers.js";

const BLOCK_NAMESPACE_PATTERN = /^\s*namespace\s+([A-Za-z_][\w.]*)\s*\{/;
const FILE_NAMESPACE_PATTERN = /^\s*namespace\s+([A-Za-z_][\w.]*)\s*;/;
const TYPE_PATTERN =
  /^\s*(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|new|\s)*(class|interface|record|enum)\s+([A-Za-z_]\w*)\b/;
const METHOD_PATTERN =
  /^\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|partial|new)\s+)*(?:<[^>]+>\s*)?[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/;

interface ScopeEntry {
  depth: number;
  name: string;
}

function countBraces(line: string): number {
  return (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
}

function extractDotnetSymbols(fileId: string, content: string) {
  const symbols = [];
  const lines = content.split(/\r?\n/);
  const namespaceStack: ScopeEntry[] = [];
  const typeStack: ScopeEntry[] = [];
  let braceDepth = 0;
  let fileNamespace = "";
  let pendingNamespace: string | null = null;
  let pendingTypeName: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    while (namespaceStack.length > 0 && braceDepth < namespaceStack[namespaceStack.length - 1]!.depth) {
      namespaceStack.pop();
    }
    while (typeStack.length > 0 && braceDepth < typeStack[typeStack.length - 1]!.depth) {
      typeStack.pop();
    }

    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const nextBraceDepth = Math.max(0, braceDepth + countBraces(line));

    if (pendingNamespace && nextBraceDepth > braceDepth) {
      namespaceStack.push({ depth: nextBraceDepth, name: pendingNamespace });
      pendingNamespace = null;
    }
    if (pendingTypeName && nextBraceDepth > braceDepth) {
      typeStack.push({ depth: nextBraceDepth, name: pendingTypeName });
      pendingTypeName = null;
    }

    const fileNamespaceMatch = trimmed.match(FILE_NAMESPACE_PATTERN);
    if (fileNamespaceMatch?.[1]) {
      fileNamespace = fileNamespaceMatch[1];
    }

    const blockNamespaceMatch = trimmed.match(BLOCK_NAMESPACE_PATTERN);
    if (blockNamespaceMatch?.[1]) {
      const name = blockNamespaceMatch[1];
      if (nextBraceDepth > braceDepth) {
        namespaceStack.push({ depth: nextBraceDepth, name });
      } else if (!trimmed.includes("{")) {
        pendingNamespace = name;
      }
    }

    const typeMatch = trimmed.match(TYPE_PATTERN);
    if (typeMatch?.[1] && typeMatch[2]) {
      const rawKind = typeMatch[1];
      const name = typeMatch[2];
      const kind = rawKind === "record" ? "record" : (rawKind as "class" | "enum" | "interface");
      const containers = [fileNamespace, ...namespaceStack.map((scope) => scope.name), ...typeStack.map((scope) => scope.name)];
      symbols.push(
        createSymbolInfo({
          fileId,
          fullName: buildQualifiedName([...containers, name]),
          kind,
          language: "dotnet",
          line: index + 1,
          name,
          signature: trimmed,
        }),
      );

      if (nextBraceDepth > braceDepth) {
        typeStack.push({ depth: nextBraceDepth, name });
      } else if (!trimmed.includes("{") && !trimmed.endsWith(";")) {
        pendingTypeName = name;
      }
    }

    const methodMatch = trimmed.match(METHOD_PATTERN);
    if (methodMatch?.[1] && typeStack.length > 0) {
      const name = methodMatch[1];
      symbols.push(
        createSymbolInfo({
          fileId,
          fullName: buildQualifiedName([
            fileNamespace,
            ...namespaceStack.map((scope) => scope.name),
            ...typeStack.map((scope) => scope.name),
            name,
          ]),
          kind: "method",
          language: "dotnet",
          line: index + 1,
          name,
          signature: trimmed,
        }),
      );
    }

    braceDepth = nextBraceDepth;
    while (namespaceStack.length > 0 && braceDepth < namespaceStack[namespaceStack.length - 1]!.depth) {
      namespaceStack.pop();
    }
    while (typeStack.length > 0 && braceDepth < typeStack[typeStack.length - 1]!.depth) {
      typeStack.pop();
    }
  }

  return symbols.sort((left, right) => left.line - right.line || left.fullName.localeCompare(right.fullName));
}

export const dotnetAdapter: LanguageAdapter = {
  extractSymbols(fileId, content) {
    return extractDotnetSymbols(fileId, content);
  },
  language: "dotnet",
  projectMarkerPatterns: [/\.sln$/i, /\.csproj$/i],
  sourceExtensions: [".cs"],
};
