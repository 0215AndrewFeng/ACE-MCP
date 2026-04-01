import type { LanguageAdapter } from "../../core/common/types.js";
import { buildQualifiedName, createSymbolInfo } from "../helpers.js";

const PACKAGE_PATTERN = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/;
const TYPE_PATTERN =
  /^\s*(?:public|private|protected|abstract|final|static|sealed|non-sealed|strictfp|\s)*(class|interface|enum|record)\s+([A-Za-z_]\w*)\b/;
const METHOD_PATTERN =
  /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s*)?[\w<>\[\].,?&\s]+\s+([A-Za-z_]\w*)\s*\(/;

interface JavaTypeScope {
  depth: number;
  name: string;
}

function countBraces(line: string): number {
  return (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
}

function extractJavaSymbols(fileId: string, content: string) {
  const symbols = [];
  const lines = content.split(/\r?\n/);
  const typeStack: JavaTypeScope[] = [];
  let braceDepth = 0;
  let packageName = "";
  let pendingTypeName: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    while (typeStack.length > 0 && braceDepth < typeStack[typeStack.length - 1]!.depth) {
      typeStack.pop();
    }

    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      braceDepth = Math.max(0, braceDepth + countBraces(line));
      continue;
    }

    const packageMatch = trimmed.match(PACKAGE_PATTERN);
    if (packageMatch) {
      packageName = packageMatch[1] ?? "";
    }

    const typeMatch = trimmed.match(TYPE_PATTERN);
    const nextBraceDepth = Math.max(0, braceDepth + countBraces(line));
    if (pendingTypeName && nextBraceDepth > braceDepth) {
      typeStack.push({ depth: nextBraceDepth, name: pendingTypeName });
      pendingTypeName = null;
    }

    if (typeMatch) {
      const rawKind = typeMatch[1];
      const name = typeMatch[2];
      if (rawKind && name) {
        const kind = rawKind === "record" ? "record" : (rawKind as "class" | "enum" | "interface");
        const fullName = buildQualifiedName([packageName, ...typeStack.map((scope) => scope.name), name]);
        symbols.push(
          createSymbolInfo({
            fileId,
            fullName,
            kind,
            language: "java",
            line: index + 1,
            name,
            signature: trimmed,
          }),
        );

        if (nextBraceDepth > braceDepth) {
          typeStack.push({ depth: nextBraceDepth, name });
        } else if (!trimmed.includes("{")) {
          pendingTypeName = name;
        }
      }
    }

    const methodMatch = trimmed.match(METHOD_PATTERN);
    if (methodMatch && typeStack.length > 0) {
      const name = methodMatch[1];
      if (name) {
        symbols.push(
          createSymbolInfo({
            fileId,
            fullName: buildQualifiedName([packageName, ...typeStack.map((scope) => scope.name), name]),
            kind: "method",
            language: "java",
            line: index + 1,
            name,
            signature: trimmed,
          }),
        );
      }
    }

    braceDepth = nextBraceDepth;
    while (typeStack.length > 0 && braceDepth < typeStack[typeStack.length - 1]!.depth) {
      typeStack.pop();
    }
  }

  return symbols.sort((left, right) => left.line - right.line || left.fullName.localeCompare(right.fullName));
}

export const javaAdapter: LanguageAdapter = {
  extractSymbols(fileId, content) {
    return extractJavaSymbols(fileId, content);
  },
  language: "java",
  projectMarkerPatterns: [/^pom\.xml$/i, /^build\.gradle$/i, /^settings\.gradle$/i],
  sourceExtensions: [".java"],
};
