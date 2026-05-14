import type { ImportInfo, LanguageAdapter, SourceAnalysis, SymbolUsageInfo } from "../../core/common/types.js";
import { buildModulePath, buildQualifiedName, createSymbolInfo } from "../helpers.js";

const CLASS_PATTERN = /^\s*class\s+([A-Za-z_]\w*)\b/;
const FUNCTION_PATTERN = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const FROM_IMPORT_PATTERN = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/;
const IMPORT_PATTERN = /^\s*import\s+(.+)$/;
const ASSIGN_CONSTRUCTOR_PATTERN = /^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_][\w.]*)\s*\(/;
const CALL_PATTERN = /\b(?:(self|cls|[A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
const KEYWORDS = new Set(["if", "for", "while", "return", "print", "class", "def", "with", "yield"]);

interface PythonClassScope {
  indent: number;
  name: string;
}

interface PythonFunctionScope {
  className?: string;
  fullName: string;
  indent: number;
  variableTypes: Map<string, string>;
}

function getIndentWidth(line: string): number {
  return [...(line.match(/^[\t ]*/) ? line.match(/^[\t ]*/)![0] : "")]
    .map((character) => (character === "\t" ? 4 : 1))
    .reduce((sum, value) => sum + value, 0);
}

function pushUsage(usages: SymbolUsageInfo[], usage: SymbolUsageInfo): void {
  usages.push({
    ...usage,
    candidateNames: [...new Set(usage.candidateNames.filter(Boolean))],
  });
}

function analyzePythonSource(fileId: string, relativePath: string, content: string): SourceAnalysis {
  const modulePath = buildModulePath(relativePath, ".");
  const symbols = [];
  const imports: ImportInfo[] = [];
  const usages: SymbolUsageInfo[] = [];
  const lines = content.split(/\r?\n/);
  const classStack: PythonClassScope[] = [];
  const functionStack: PythonFunctionScope[] = [];

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
    while (functionStack.length > 0 && indent <= functionStack[functionStack.length - 1]!.indent) {
      functionStack.pop();
    }

    const fromImportMatch = trimmed.match(FROM_IMPORT_PATTERN);
    if (fromImportMatch?.[1] && fromImportMatch[2]) {
      const sourceModule = fromImportMatch[1];
      const parts = fromImportMatch[2].split(",").map((part) => part.trim()).filter(Boolean);
      for (const part of parts) {
        const [name, alias] = part.split(/\s+as\s+/).map((segment) => segment.trim());
        if (!name) {
          continue;
        }
        const resolvedAlias = alias || name;
        imports.push({
          alias: resolvedAlias,
          importedName: name,
          line: index + 1,
          sourceModule,
        });
        pushUsage(usages, {
          candidateNames: [name, `${sourceModule}.${name}`],
          kind: "import",
          line: index + 1,
          rawName: resolvedAlias,
        });
      }
      continue;
    }

    const importMatch = trimmed.match(IMPORT_PATTERN);
    if (importMatch?.[1]) {
      const modules = importMatch[1].split(",").map((part) => part.trim()).filter(Boolean);
      for (const moduleEntry of modules) {
        const [moduleName, alias] = moduleEntry.split(/\s+as\s+/).map((segment) => segment.trim());
        if (!moduleName) {
          continue;
        }
        const resolvedAlias = alias || moduleName.split(".").pop() || moduleName;
        imports.push({
          alias: resolvedAlias,
          importedName: "*",
          line: index + 1,
          sourceModule: moduleName,
        });
      }
      continue;
    }

    const classMatch = line.match(CLASS_PATTERN);
    if (classMatch?.[1]) {
      const name = classMatch[1];
      const fullName = buildQualifiedName([...classStack.map((scope) => scope.name), name]);
      symbols.push(
        createSymbolInfo({
          canonicalName: buildQualifiedName([modulePath, fullName]),
          containerName: classStack[classStack.length - 1]?.name,
          fileId,
          fullName,
          kind: "class",
          language: "python",
          line: index + 1,
          modulePath,
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
      const fullName = buildQualifiedName([...classStack.map((scope) => scope.name), name]);
      symbols.push(
        createSymbolInfo({
          canonicalName: buildQualifiedName([modulePath, fullName]),
          containerName: classStack[classStack.length - 1]?.name,
          fileId,
          fullName,
          kind: inClass ? "method" : "function",
          language: "python",
          line: index + 1,
          modulePath,
          name,
          signature: trimmed,
        }),
      );
      functionStack.push({
        className: classStack[classStack.length - 1]?.name,
        fullName,
        indent,
        variableTypes: new Map<string, string>(),
      });
      continue;
    }

    const currentFunction = functionStack[functionStack.length - 1];
    if (!currentFunction) {
      continue;
    }

    const assignMatch = trimmed.match(ASSIGN_CONSTRUCTOR_PATTERN);
    if (assignMatch?.[1] && assignMatch[2]) {
      const variableName = assignMatch[1];
      const constructorName = assignMatch[2].split(".").pop() ?? assignMatch[2];
      currentFunction.variableTypes.set(variableName, constructorName);
      pushUsage(usages, {
        candidateNames: [constructorName, assignMatch[2]],
        kind: "instantiation",
        line: index + 1,
        ownerSymbol: currentFunction.fullName,
        rawName: constructorName,
      });
    }

    for (const match of trimmed.matchAll(CALL_PATTERN)) {
      const receiver = match[1];
      const name = match[2];
      if (!name || KEYWORDS.has(name)) {
        continue;
      }

      const candidateNames = [name];
      if (!receiver) {
        if (currentFunction.className) {
          candidateNames.unshift(`${currentFunction.className}.${name}`);
        }
      } else if (receiver === "self" || receiver === "cls") {
        if (currentFunction.className) {
          candidateNames.unshift(`${currentFunction.className}.${name}`);
        }
      } else if (currentFunction.variableTypes.has(receiver)) {
        candidateNames.unshift(`${currentFunction.variableTypes.get(receiver)}.${name}`);
      } else {
        candidateNames.unshift(`${receiver}.${name}`);
      }

      pushUsage(usages, {
        candidateNames,
        kind: "call",
        line: index + 1,
        ownerSymbol: currentFunction.fullName,
        rawName: receiver ? `${receiver}.${name}` : name,
      });
    }
  }

  return {
    imports,
    symbols: symbols.sort((left, right) => left.line - right.line || left.fullName.localeCompare(right.fullName)),
    usages,
  };
}

export const pythonAdapter: LanguageAdapter = {
  analyzeSource(fileId, relativePath, content) {
    return analyzePythonSource(fileId, relativePath, content);
  },
  extractSymbols(fileId, content) {
    return analyzePythonSource(fileId, "source.py", content).symbols;
  },
  language: "python",
  projectMarkerPatterns: [/^pyproject\.toml$/i, /^requirements\.txt$/i, /^setup\.py$/i],
  sourceExtensions: [".py"],
};
