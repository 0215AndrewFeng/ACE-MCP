import type { ImportInfo, LanguageAdapter, SourceAnalysis, SymbolUsageInfo } from "../../core/common/types.js";
import { buildQualifiedName, createSymbolInfo } from "../helpers.js";

const PACKAGE_PATTERN = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/;
const IMPORT_PATTERN = /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*(?:\.\*)?)\s*;/;
const TYPE_PATTERN =
  /^\s*(?:public|private|protected|abstract|final|static|sealed|non-sealed|strictfp|\s)*(class|interface|enum|record)\s+([A-Za-z_]\w*)\b/;
const METHOD_PATTERN =
  /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s*)?[\w<>\[\].,?&\s]+\s+([A-Za-z_]\w*)\s*\(/;
const VARIABLE_INIT_PATTERN =
  /\b([A-Z][A-Za-z0-9_]*)\s+([a-zA-Z_]\w*)\s*=\s*new\s+([A-Z][A-Za-z0-9_]*)\s*\(/;
const METHOD_CALL_PATTERN = /\b(?:(this|super|[A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "super", "this"]);

interface JavaTypeScope {
  depth: number;
  fullName: string;
  name: string;
}

interface JavaMethodScope {
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

function analyzeJavaSource(fileId: string, content: string): SourceAnalysis {
  const symbols = [];
  const imports: ImportInfo[] = [];
  const usages: SymbolUsageInfo[] = [];
  const lines = content.split(/\r?\n/);
  const typeStack: JavaTypeScope[] = [];
  let currentMethod: JavaMethodScope | undefined;
  let braceDepth = 0;
  let packageName = "";
  let pendingTypeName: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    while (typeStack.length > 0 && braceDepth < typeStack[typeStack.length - 1]!.depth) {
      typeStack.pop();
    }
    if (currentMethod && braceDepth < currentMethod.depth) {
      currentMethod = undefined;
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

    const importMatch = trimmed.match(IMPORT_PATTERN);
    if (importMatch?.[1]) {
      const fullImport = importMatch[1];
      const lastDot = fullImport.lastIndexOf(".");
      const importedName = fullImport.endsWith(".*") ? "*" : fullImport.slice(lastDot + 1);
      const sourceModule = fullImport.endsWith(".*") ? fullImport.slice(0, -2) : fullImport.slice(0, lastDot);
      const alias = importedName === "*" ? "*" : importedName;
      imports.push({
        alias,
        importedName,
        line: index + 1,
        sourceModule,
      });
      if (importedName !== "*") {
        pushUsage(usages, {
          candidateNames: [fullImport, importedName],
          kind: "import",
          line: index + 1,
          rawName: alias,
        });
      }
    }

    const nextBraceDepth = Math.max(0, braceDepth + countBraces(line));
    if (pendingTypeName && nextBraceDepth > braceDepth) {
      typeStack.push({
        depth: nextBraceDepth,
        fullName: buildQualifiedName([packageName, ...typeStack.map((scope) => scope.name), pendingTypeName]),
        name: pendingTypeName,
      });
      pendingTypeName = null;
    }

    const typeMatch = trimmed.match(TYPE_PATTERN);
    if (typeMatch) {
      const rawKind = typeMatch[1];
      const name = typeMatch[2];
      if (rawKind && name) {
        const kind = rawKind === "record" ? "record" : (rawKind as "class" | "enum" | "interface");
        const containerName = typeStack[typeStack.length - 1]?.name;
        const fullName = buildQualifiedName([packageName, ...typeStack.map((scope) => scope.name), name]);
        symbols.push(
          createSymbolInfo({
            canonicalName: fullName,
            containerName,
            fileId,
            fullName,
            kind,
            language: "java",
            line: index + 1,
            modulePath: packageName,
            name,
            signature: trimmed,
          }),
        );

        if (nextBraceDepth > braceDepth) {
          typeStack.push({ depth: nextBraceDepth, fullName, name });
        } else if (!trimmed.includes("{")) {
          pendingTypeName = name;
        }
      }
    }

    const methodMatch = trimmed.match(METHOD_PATTERN);
    if (methodMatch && typeStack.length > 0) {
      const name = methodMatch[1];
      if (name) {
        const className = typeStack[typeStack.length - 1]!.name;
        const fullName = buildQualifiedName([packageName, ...typeStack.map((scope) => scope.name), name]);
        symbols.push(
          createSymbolInfo({
            canonicalName: fullName,
            containerName: className,
            fileId,
            fullName,
            kind: "method",
            language: "java",
            line: index + 1,
            modulePath: packageName,
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
    }

    if (currentMethod) {
      const variableMatch = trimmed.match(VARIABLE_INIT_PATTERN);
      if (variableMatch?.[2] && variableMatch[3]) {
        const variableType = variableMatch[3];
        currentMethod.variableTypes.set(variableMatch[2], variableType);
        pushUsage(usages, {
          candidateNames: [variableType],
          kind: "instantiation",
          line: index + 1,
          ownerSymbol: currentMethod.fullName,
          rawName: variableType,
        });
      }

      const newMatches = [...trimmed.matchAll(/\bnew\s+([A-Z][A-Za-z0-9_]*)\s*\(/g)];
      for (const match of newMatches) {
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
        } else if (receiver === "this" || receiver === "super") {
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

export const javaAdapter: LanguageAdapter = {
  analyzeSource(fileId, relativePath, content) {
    return analyzeJavaSource(fileId, content);
  },
  extractSymbols(fileId, content) {
    return analyzeJavaSource(fileId, content).symbols;
  },
  language: "java",
  projectMarkerPatterns: [/^pom\.xml$/i, /^build\.gradle$/i, /^settings\.gradle$/i],
  sourceExtensions: [".java"],
};
