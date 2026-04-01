import type { LanguageAdapter } from "../../core/common/types.js";
import { buildQualifiedName, createSymbolInfo } from "../helpers.js";

const CLASS_PATTERN = /^\s*class\s+([A-Za-z_]\w*)\b/;
const FUNCTION_PATTERN = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;

interface PythonClassScope {
  indent: number;
  name: string;
}

function getIndentWidth(line: string): number {
  return [...(line.match(/^[\t ]*/) ? line.match(/^[\t ]*/)![0] : "")]
    .map((character) => (character === "\t" ? 4 : 1))
    .reduce((sum, value) => sum + value, 0);
}

function extractPythonSymbols(fileId: string, content: string) {
  const symbols = [];
  const lines = content.split(/\r?\n/);
  const classStack: PythonClassScope[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const indent = getIndentWidth(line);
    while (classStack.length > 0 && indent <= classStack[classStack.length - 1]!.indent) {
      classStack.pop();
    }

    const classMatch = line.match(CLASS_PATTERN);
    if (classMatch?.[1]) {
      const name = classMatch[1];
      symbols.push(
        createSymbolInfo({
          fileId,
          fullName: buildQualifiedName([...classStack.map((scope) => scope.name), name]),
          kind: "class",
          language: "python",
          line: index + 1,
          name,
          signature: trimmed,
        }),
      );
      classStack.push({ indent, name });
      continue;
    }

    const functionMatch = line.match(FUNCTION_PATTERN);
    if (functionMatch?.[1]) {
      const name = functionMatch[1];
      const inClass = classStack.length > 0;
      symbols.push(
        createSymbolInfo({
          fileId,
          fullName: buildQualifiedName([...classStack.map((scope) => scope.name), name]),
          kind: inClass ? "method" : "function",
          language: "python",
          line: index + 1,
          name,
          signature: trimmed,
        }),
      );
    }
  }

  return symbols.sort((left, right) => left.line - right.line || left.fullName.localeCompare(right.fullName));
}

export const pythonAdapter: LanguageAdapter = {
  extractSymbols(fileId, content) {
    return extractPythonSymbols(fileId, content);
  },
  language: "python",
  projectMarkerPatterns: [/^pyproject\.toml$/i, /^requirements\.txt$/i, /^setup\.py$/i],
  sourceExtensions: [".py"],
};
