import type { ImportInfo, LanguageAdapter, SourceAnalysis, SymbolUsageInfo } from "../../core/common/types.js";
import { buildQualifiedName, createSymbolInfo } from "../helpers.js";

const BLOCK_NAMESPACE_PATTERN = /^\s*namespace\s+([A-Za-z_][\w.]*)\s*\{/;
const FILE_NAMESPACE_PATTERN = /^\s*namespace\s+([A-Za-z_][\w.]*)\s*;/;
const USING_PATTERN = /^\s*using\s+([A-Za-z_][\w.]*)\s*;/;
const TYPE_PATTERN =
  /^\s*(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|new|\s)*(class|interface|record|enum)\s+([A-Za-z_]\w*)\b/;
const METHOD_PATTERN =
  /^\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|partial|new)\s+)*(?:<[^>]+>\s*)?[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/;
const VARIABLE_INIT_PATTERN =
  /\b(?:var|[A-Z][A-Za-z0-9_<>?,]*)\s+([a-zA-Z_]\w*)\s*=\s*new\s+([A-Z][A-Za-z0-9_]*)\s*\(/;
const METHOD_CALL_PATTERN = /\b(?:(this|base|[A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "base", "this"]);

interface ScopeEntry {
  depth: number;
  name: string;
}

interface DotnetMethodScope {
  className: string;
  depth: number;
  fullName: string;
  variableTypes: Map<string, string>;
}

function countBraces(line: string): number {
  return (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
}

function pushUsage(usages: SymbolUsageInfo[], usage: SymbolUsageInfo): void {
  usages.push({
    ...usage,
    candidateNames: [...new Set(usage.candidateNames.filter(Boolean))],
  });
}

function analyzeDotnetSource(fileId: string, content: string): SourceAnalysis {
  const symbols = [];
  const imports: ImportInfo[] = [];
  const usages: SymbolUsageInfo[] = [];
  const lines = content.split(/\r?\n/);
  const namespaceStack: ScopeEntry[] = [];
  const typeStack: ScopeEntry[] = [];
  let currentMethod: DotnetMethodScope | undefined;
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
    if (currentMethod && braceDepth < currentMethod.depth) {
      currentMethod = undefined;
    }

    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const nextBraceDepth = Math.max(0, braceDepth + countBraces(line));
    if (trimmed.length === 0) {
      braceDepth = nextBraceDepth;
      continue;
    }

    const usingMatch = trimmed.match(USING_PATTERN);
    if (usingMatch?.[1]) {
      const namespaceName = usingMatch[1];
      imports.push({
        alias: namespaceName.split(".").pop() ?? namespaceName,
        importedName: "*",
        line: index + 1,
        sourceModule: namespaceName,
      });
    }

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

    const namespacePath = buildQualifiedName([fileNamespace, ...namespaceStack.map((scope) => scope.name)]);
    const typeMatch = trimmed.match(TYPE_PATTERN);
    if (typeMatch?.[1] && typeMatch[2]) {
      const rawKind = typeMatch[1];
      const name = typeMatch[2];
      const kind = rawKind === "record" ? "record" : (rawKind as "class" | "enum" | "interface");
      const fullName = buildQualifiedName([namespacePath, ...typeStack.map((scope) => scope.name), name]);
      symbols.push(
        createSymbolInfo({
          canonicalName: fullName,
          containerName: typeStack[typeStack.length - 1]?.name,
          fileId,
          fullName,
          kind,
          language: "dotnet",
          line: index + 1,
          modulePath: namespacePath,
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
      const className = typeStack[typeStack.length - 1]!.name;
      const fullName = buildQualifiedName([namespacePath, ...typeStack.map((scope) => scope.name), name]);
      symbols.push(
        createSymbolInfo({
          canonicalName: fullName,
          containerName: className,
          fileId,
          fullName,
          kind: "method",
          language: "dotnet",
          line: index + 1,
          modulePath: namespacePath,
          name,
          signature: trimmed,
        }),
      );
      currentMethod = {
        className,
        depth: nextBraceDepth > braceDepth ? nextBraceDepth : braceDepth + 1,
        fullName,
        variableTypes: new Map<string, string>(),
      };
    }

    if (currentMethod) {
      const variableMatch = trimmed.match(VARIABLE_INIT_PATTERN);
      if (variableMatch?.[1] && variableMatch[2]) {
        currentMethod.variableTypes.set(variableMatch[1], variableMatch[2]);
        pushUsage(usages, {
          candidateNames: [variableMatch[2]],
          kind: "instantiation",
          line: index + 1,
          ownerSymbol: currentMethod.fullName,
          rawName: variableMatch[2],
        });
      }

      for (const match of trimmed.matchAll(/\bnew\s+([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
        const typeName = match[1];
        if (!typeName) {
          continue;
        }
        pushUsage(usages, {
          candidateNames: [typeName],
          kind: "instantiation",
          line: index + 1,
          ownerSymbol: currentMethod.fullName,
          rawName: typeName,
        });
      }

      for (const match of trimmed.matchAll(METHOD_CALL_PATTERN)) {
        const receiver = match[1];
        const methodName = match[2];
        if (!methodName || KEYWORDS.has(methodName)) {
          continue;
        }

        const candidateNames = [methodName];
        if (!receiver) {
          candidateNames.unshift(`${currentMethod.className}.${methodName}`);
        } else if (receiver === "this" || receiver === "base") {
          candidateNames.unshift(`${currentMethod.className}.${methodName}`);
        } else if (currentMethod.variableTypes.has(receiver)) {
          candidateNames.unshift(`${currentMethod.variableTypes.get(receiver)}.${methodName}`);
        } else if (/^[A-Z]/.test(receiver)) {
          candidateNames.unshift(`${receiver}.${methodName}`);
        }

        pushUsage(usages, {
          candidateNames,
          kind: "call",
          line: index + 1,
          ownerSymbol: currentMethod.fullName,
          rawName: receiver ? `${receiver}.${methodName}` : methodName,
        });
      }
    }

    braceDepth = nextBraceDepth;
    while (namespaceStack.length > 0 && braceDepth < namespaceStack[namespaceStack.length - 1]!.depth) {
      namespaceStack.pop();
    }
    while (typeStack.length > 0 && braceDepth < typeStack[typeStack.length - 1]!.depth) {
      typeStack.pop();
    }
    if (currentMethod && braceDepth < currentMethod.depth) {
      currentMethod = undefined;
    }
  }

  return {
    imports,
    symbols: symbols.sort((left, right) => left.line - right.line || left.fullName.localeCompare(right.fullName)),
    usages,
  };
}

export const dotnetAdapter: LanguageAdapter = {
  analyzeSource(fileId, relativePath, content) {
    return analyzeDotnetSource(fileId, content);
  },
  extractSymbols(fileId, content) {
    return analyzeDotnetSource(fileId, content).symbols;
  },
  language: "dotnet",
  projectMarkerPatterns: [/\.sln$/i, /\.csproj$/i],
  sourceExtensions: [".cs"],
};
