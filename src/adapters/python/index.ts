import type { ImportInfo, LanguageAdapter, SourceAnalysis, SymbolUsageInfo } from "../../core/common/types.js";
import { buildModulePath, buildQualifiedName, createSymbolInfo } from "../helpers.js";

const CLASS_PATTERN = /^\s*class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/;
const FUNCTION_PATTERN = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;
const FROM_IMPORT_PATTERN = /^\s*from\s+(\.*[A-Za-z_][\w.]*)\s+import\s+(.+)$/;
const IMPORT_PATTERN = /^\s*import\s+(.+)$/;
const ASSIGN_CONSTRUCTOR_PATTERN = /^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_][\w.]*)\s*\(/;
const CALL_PATTERN = /\b(?:(self|cls|[A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
const DECORATOR_PATTERN = /^\s*@([A-Za-z_][\w.]*(?:\([^)]*\))?)/;
const RETURN_TYPE_PATTERN = /\)\s*->\s*([A-Za-z_][\w.\[\], |]*)\s*:/;
const LAMBDA_ASSIGN_PATTERN = /^\s*([A-Za-z_]\w*)\s*(?::\s*[^=]+)?\s*=\s*lambda\b/;
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

/** Extract simple type names from a type annotation like `Optional[List[str]]` */
function extractTypeNames(annotation: string): string[] {
  return [...annotation.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]!);
}

function analyzePythonSource(fileId: string, relativePath: string, content: string): SourceAnalysis {
  const modulePath = buildModulePath(relativePath, ".");
  const symbols = [];
  const imports: ImportInfo[] = [];
  const usages: SymbolUsageInfo[] = [];
  const lines = content.split(/\r?\n/);
  const classStack: PythonClassScope[] = [];
  const functionStack: PythonFunctionScope[] = [];
  /** Map imported simple name → qualified name */
  const importMap = new Map<string, string>();
  /** Pending decorators collected before the next class/def */
  let pendingDecorators: { name: string; line: number }[] = [];
  /** Multiline import accumulation */
  let multilineImportAccum = "";
  let multilineImportStart = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    /* ── multiline import continuation ────────────────────── */
    if (multilineImportAccum) {
      multilineImportAccum += " " + trimmed.replace(/[()]/g, "");
      if (trimmed.includes(")") || !trimmed.endsWith("\\")) {
        // Process the accumulated import
        const fullLine = multilineImportAccum;
        const fromMatch = fullLine.match(/^\s*from\s+(\.*[A-Za-z_][\w.]*)\s+import\s+(.+)$/);
        if (fromMatch?.[1] && fromMatch[2]) {
          processFromImport(fromMatch[1], fromMatch[2], multilineImportStart, imports, usages, importMap);
        }
        multilineImportAccum = "";
        multilineImportStart = -1;
        continue;
      }
      continue;
    }

    const indent = getIndentWidth(line);
    while (classStack.length > 0 && indent <= classStack[classStack.length - 1]!.indent) {
      classStack.pop();
    }
    while (functionStack.length > 0 && indent <= functionStack[functionStack.length - 1]!.indent) {
      functionStack.pop();
    }

    /* ── decorator ────────────────────────────────────────── */
    const decoMatch = trimmed.match(DECORATOR_PATTERN);
    if (decoMatch?.[1]) {
      const decoFull = decoMatch[1].replace(/\(.*/, ""); // strip args
      const decoSimple = decoFull.split(".").pop() ?? decoFull;
      pendingDecorators.push({ name: decoFull, line: index + 1 });
      const owner = functionStack[functionStack.length - 1]?.fullName ?? classStack[classStack.length - 1]?.name;
      pushUsage(usages, {
        candidateNames: [importMap.get(decoSimple) ?? decoFull, decoSimple, decoFull],
        kind: "usage",
        line: index + 1,
        ownerSymbol: owner,
        rawName: `@${decoFull}`,
      });
      continue;
    }

    /* ── from ... import (possibly multiline) ─────────────── */
    const fromImportMatch = trimmed.match(FROM_IMPORT_PATTERN);
    if (fromImportMatch?.[1]) {
      // Check if multiline (has open paren or trailing backslash)
      if ((trimmed.includes("(") && !trimmed.includes(")")) || trimmed.endsWith("\\")) {
        multilineImportAccum = trimmed.replace(/[()\\]/g, "");
        multilineImportStart = index + 1;
        continue;
      }
      processFromImport(fromImportMatch[1], fromImportMatch[2] ?? "", index + 1, imports, usages, importMap);
      pendingDecorators = [];
      continue;
    }

    const importMatch = trimmed.match(IMPORT_PATTERN);
    if (importMatch?.[1]) {
      const modules = importMatch[1].split(",").map((part) => part.trim()).filter(Boolean);
      for (const moduleEntry of modules) {
        const [moduleName, alias] = moduleEntry.split(/\s+as\s+/).map((segment) => segment.trim());
        if (!moduleName) continue;
        const resolvedAlias = alias || moduleName.split(".").pop() || moduleName;
        imports.push({
          alias: resolvedAlias,
          importedName: "*",
          line: index + 1,
          sourceModule: moduleName,
        });
        importMap.set(resolvedAlias, moduleName);
      }
      pendingDecorators = [];
      continue;
    }

    /* ── class ─────────────────────────────────────────────── */
    const classMatch = line.match(CLASS_PATTERN);
    if (classMatch?.[1]) {
      const name = classMatch[1];
      const basesClause = classMatch[2] ?? "";
      const fullName = buildQualifiedName([...classStack.map((s) => s.name), name]);

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

      // Base classes → type usages
      if (basesClause) {
        const bases = basesClause.split(",").map((b) => b.trim().replace(/\(.*/, "").split("[")[0]!.trim()).filter(Boolean);
        for (const base of bases) {
          if (base === "object" || base.startsWith("metaclass=")) continue;
          const simpleName = base.split(".").pop() ?? base;
          pushUsage(usages, {
            candidateNames: [importMap.get(simpleName) ?? base, simpleName, base],
            kind: "type",
            line: index + 1,
            ownerSymbol: fullName,
            rawName: base,
          });
        }
      }

      classStack.push({ indent, name });
      pendingDecorators = [];
      continue;
    }

    /* ── function / method ─────────────────────────────────── */
    const functionMatch = line.match(FUNCTION_PATTERN);
    if (functionMatch?.[1]) {
      const name = functionMatch[1];
      const params = functionMatch[2] ?? "";
      const inClass = classStack.length > 0;
      const fullName = buildQualifiedName([...classStack.map((s) => s.name), name]);
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

      const varTypes = new Map<string, string>();

      // Extract type hints from params: `x: SomeType`
      for (const paramMatch of params.matchAll(/(\w+)\s*:\s*([A-Za-z_][\w.\[\], |]*)/g)) {
        const pName = paramMatch[1]!;
        const pType = paramMatch[2]!;
        for (const tn of extractTypeNames(pType)) {
          pushUsage(usages, {
            candidateNames: [importMap.get(tn) ?? tn, tn],
            kind: "type",
            line: index + 1,
            ownerSymbol: fullName,
            rawName: tn,
          });
          if (pName !== "self" && pName !== "cls") {
            varTypes.set(pName, tn);
          }
        }
      }

      // Return type hint
      const retMatch = trimmed.match(RETURN_TYPE_PATTERN);
      if (retMatch?.[1]) {
        for (const tn of extractTypeNames(retMatch[1])) {
          pushUsage(usages, {
            candidateNames: [importMap.get(tn) ?? tn, tn],
            kind: "type",
            line: index + 1,
            ownerSymbol: fullName,
            rawName: tn,
          });
        }
      }

      functionStack.push({
        className: classStack[classStack.length - 1]?.name,
        fullName,
        indent,
        variableTypes: varTypes,
      });
      pendingDecorators = [];
      continue;
    }

    /* ── lambda assignment ─────────────────────────────────── */
    const lambdaMatch = trimmed.match(LAMBDA_ASSIGN_PATTERN);
    if (lambdaMatch?.[1] && functionStack.length === 0 && classStack.length === 0) {
      const name = lambdaMatch[1];
      symbols.push(
        createSymbolInfo({
          canonicalName: buildQualifiedName([modulePath, name]),
          fileId,
          fullName: name,
          kind: "function",
          language: "python",
          line: index + 1,
          modulePath,
          name,
          signature: trimmed,
        }),
      );
      pendingDecorators = [];
      continue;
    }

    pendingDecorators = [];

    /* ── usages inside functions ───────────────────────────── */
    const currentFunction = functionStack[functionStack.length - 1];
    if (!currentFunction) continue;

    const assignMatch = trimmed.match(ASSIGN_CONSTRUCTOR_PATTERN);
    if (assignMatch?.[1] && assignMatch[2]) {
      const variableName = assignMatch[1];
      const constructorName = assignMatch[2].split(".").pop() ?? assignMatch[2];
      currentFunction.variableTypes.set(variableName, constructorName);
      pushUsage(usages, {
        candidateNames: [importMap.get(constructorName) ?? constructorName, constructorName, assignMatch[2]],
        kind: "instantiation",
        line: index + 1,
        ownerSymbol: currentFunction.fullName,
        rawName: constructorName,
      });
    }

    for (const match of trimmed.matchAll(CALL_PATTERN)) {
      const receiver = match[1];
      const name = match[2];
      if (!name || KEYWORDS.has(name)) continue;

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
        const resolved = importMap.get(receiver);
        if (resolved) candidateNames.unshift(`${resolved}.${name}`);
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

function processFromImport(
  sourceModule: string,
  namesPart: string,
  line: number,
  imports: ImportInfo[],
  usages: SymbolUsageInfo[],
  importMap: Map<string, string>,
): void {
  const parts = namesPart
    .replace(/[()]/g, "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    const [name, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
    if (!name) continue;
    const resolvedAlias = alias || name;
    imports.push({ alias: resolvedAlias, importedName: name, line, sourceModule });
    importMap.set(resolvedAlias, `${sourceModule}.${name}`);
    pushUsage(usages, {
      candidateNames: [name, `${sourceModule}.${name}`],
      kind: "import",
      line,
      rawName: resolvedAlias,
    });
  }
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
