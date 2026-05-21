import type { ImportInfo, LanguageAdapter, SourceAnalysis, SymbolUsageInfo } from "../../core/common/types.js";
import { buildQualifiedName, createSymbolInfo } from "../helpers.js";

/* ── Patterns ─────────────────────────────────────────────────────── */

const BLOCK_NAMESPACE_PATTERN = /^\s*namespace\s+([A-Za-z_][\w.]*)\s*\{/;
const FILE_NAMESPACE_PATTERN = /^\s*namespace\s+([A-Za-z_][\w.]*)\s*;/;
const USING_PATTERN = /^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/;
const USING_ALIAS_PATTERN = /^\s*using\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_][\w.]*)\s*;/;
const GLOBAL_USING_PATTERN = /^\s*global\s+using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/;
const TYPE_PATTERN =
  /^\s*(?:\[[^\]]+\]\s*)*(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|new|\s)*(class|interface|record|enum|struct)\s+([A-Za-z_]\w*)\b/;
const INHERITANCE_PATTERN = /:\s*([\w<>\[\].,?\s&]+)/;
const PROPERTY_PATTERN =
  /^\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|new|required)\s+)*([A-Z][\w<>\[\]?,]*)\s+([A-Z]\w*)\s*\{/;
const CONSTRUCTOR_PATTERN =
  /^\s*(?:(?:public|private|protected|internal|static)\s+)?([A-Z]\w*)\s*\(/;
const METHOD_PATTERN =
  /^\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|partial|new)\s+)*(?:<[^>]+>\s*)?[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\(/;
const DELEGATE_PATTERN =
  /^\s*(?:public|private|protected|internal|unsafe|\s)*delegate\s+[\w<>\[\].,?\s]+\s+([A-Za-z_]\w*)\s*\(/;
const EVENT_PATTERN =
  /^\s*(?:public|private|protected|internal|static|virtual|override|abstract|sealed|new|\s)*event\s+([A-Z][\w<>?,]*)\s+([A-Za-z_]\w*)\s*[;{]/;
const ATTRIBUTE_PATTERN = /^\s*\[([A-Za-z_]\w*(?:\([^)]*\))?)\]/;
const VARIABLE_INIT_PATTERN =
  /\b(?:var|[A-Z][A-Za-z0-9_<>?,]*)\s+([a-zA-Z_]\w*)\s*=\s*new\s+([A-Z][A-Za-z0-9_]*)\s*[(\{]/;
const METHOD_CALL_PATTERN = /\b(?:(this|base|[A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "base", "this", "foreach", "using", "lock"]);

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

function stripGenerics(type: string): string {
  return type.replace(/<[^>]*>/g, "").replace(/\[.*?\]/g, "").trim();
}

function isComment(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

/* ── Main analyser ────────────────────────────────────────────────── */

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
  const usingAliases = new Map<string, string>();

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
    if (trimmed.length === 0 || isComment(trimmed)) {
      braceDepth = nextBraceDepth;
      continue;
    }

    /* ── using ─────────────────────────────────────────────── */
    const aliasMatch = trimmed.match(USING_ALIAS_PATTERN);
    if (aliasMatch?.[1] && aliasMatch[2]) {
      usingAliases.set(aliasMatch[1], aliasMatch[2]);
      imports.push({
        alias: aliasMatch[1],
        importedName: aliasMatch[2].split(".").pop() ?? aliasMatch[2],
        line: index + 1,
        sourceModule: aliasMatch[2],
      });
      braceDepth = nextBraceDepth;
      continue;
    }

    const globalMatch = trimmed.match(GLOBAL_USING_PATTERN);
    if (globalMatch?.[1]) {
      imports.push({
        alias: globalMatch[1].split(".").pop() ?? globalMatch[1],
        importedName: "*",
        line: index + 1,
        sourceModule: globalMatch[1],
      });
      braceDepth = nextBraceDepth;
      continue;
    }

    const usingMatch = trimmed.match(USING_PATTERN);
    if (usingMatch?.[1]) {
      imports.push({
        alias: usingMatch[1].split(".").pop() ?? usingMatch[1],
        importedName: "*",
        line: index + 1,
        sourceModule: usingMatch[1],
      });
    }

    /* ── attribute ─────────────────────────────────────────── */
    const attrMatch = trimmed.match(ATTRIBUTE_PATTERN);
    if (attrMatch?.[1]) {
      const attrName = attrMatch[1].replace(/\(.*/, "");
      const owner = currentMethod?.fullName ?? typeStack[typeStack.length - 1]?.name;
      pushUsage(usages, {
        candidateNames: [attrName, `${attrName}Attribute`],
        kind: "usage",
        line: index + 1,
        ownerSymbol: owner,
        rawName: `[${attrName}]`,
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

    const namespacePath = buildQualifiedName([fileNamespace, ...namespaceStack.map((s) => s.name)]);

    /* ── delegate ──────────────────────────────────────────── */
    const delegateMatch = trimmed.match(DELEGATE_PATTERN);
    if (delegateMatch?.[1]) {
      const name = delegateMatch[1];
      const fullName = buildQualifiedName([namespacePath, ...typeStack.map((s) => s.name), name]);
      symbols.push(
        createSymbolInfo({
          canonicalName: fullName,
          containerName: typeStack[typeStack.length - 1]?.name,
          fileId,
          fullName,
          kind: "function", // delegate maps to function
          language: "dotnet",
          line: index + 1,
          modulePath: namespacePath,
          name,
          signature: trimmed,
        }),
      );
    }

    /* ── event ─────────────────────────────────────────────── */
    const eventMatch = trimmed.match(EVENT_PATTERN);
    if (eventMatch?.[1] && eventMatch[2] && typeStack.length > 0) {
      const eventType = stripGenerics(eventMatch[1]);
      const eventName = eventMatch[2];
      const fullName = buildQualifiedName([namespacePath, ...typeStack.map((s) => s.name), eventName]);
      symbols.push(
        createSymbolInfo({
          canonicalName: fullName,
          containerName: typeStack[typeStack.length - 1]?.name,
          fileId,
          fullName,
          kind: "field",
          language: "dotnet",
          line: index + 1,
          modulePath: namespacePath,
          name: eventName,
          signature: trimmed,
        }),
      );
      pushUsage(usages, {
        candidateNames: [eventType],
        kind: "type",
        line: index + 1,
        ownerSymbol: typeStack[typeStack.length - 1]?.name,
        rawName: eventType,
      });
    }

    /* ── type declaration ──────────────────────────────────── */
    const typeMatch = trimmed.match(TYPE_PATTERN);
    if (typeMatch?.[1] && typeMatch[2]) {
      const rawKind = typeMatch[1];
      const name = typeMatch[2];
      const kind = rawKind === "struct" ? "class" : rawKind === "record" ? "record" : (rawKind as "class" | "enum" | "interface");
      const fullName = buildQualifiedName([namespacePath, ...typeStack.map((s) => s.name), name]);
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

      // inheritance: class Foo : Bar, IFoo
      const inheritMatch = trimmed.match(INHERITANCE_PATTERN);
      if (inheritMatch?.[1]) {
        const bases = inheritMatch[1].split(",").map((b) => stripGenerics(b.trim())).filter(Boolean);
        for (const base of bases) {
          if (!base || base === "where") break; // stop at generic constraints
          pushUsage(usages, {
            candidateNames: [base],
            kind: "type",
            line: index + 1,
            ownerSymbol: fullName,
            rawName: base,
          });
        }
      }

      if (nextBraceDepth > braceDepth) {
        typeStack.push({ depth: nextBraceDepth, name });
      } else if (!trimmed.includes("{") && !trimmed.endsWith(";")) {
        pendingTypeName = name;
      }
    }

    /* ── constructor ───────────────────────────────────────── */
    if (!typeMatch && typeStack.length > 0) {
      const ctorMatch = trimmed.match(CONSTRUCTOR_PATTERN);
      if (ctorMatch?.[1] && ctorMatch[1] === typeStack[typeStack.length - 1]!.name) {
        const name = ctorMatch[1];
        const className = typeStack[typeStack.length - 1]!.name;
        const fullName = buildQualifiedName([namespacePath, ...typeStack.map((s) => s.name), name]);
        const alreadyAdded = symbols.some((s) => s.line === index + 1);
        if (!alreadyAdded) {
          symbols.push(
            createSymbolInfo({
              canonicalName: fullName,
              containerName: className,
              fileId,
              fullName,
              kind: "constructor",
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
      }
    }

    /* ── property ──────────────────────────────────────────── */
    if (!typeMatch && !currentMethod && typeStack.length > 0) {
      const propMatch = trimmed.match(PROPERTY_PATTERN);
      if (propMatch?.[1] && propMatch[2]) {
        const propType = stripGenerics(propMatch[1]);
        const propName = propMatch[2];
        const className = typeStack[typeStack.length - 1]!.name;
        const fullName = buildQualifiedName([namespacePath, ...typeStack.map((s) => s.name), propName]);
        symbols.push(
          createSymbolInfo({
            canonicalName: fullName,
            containerName: className,
            fileId,
            fullName,
            kind: "property",
            language: "dotnet",
            line: index + 1,
            modulePath: namespacePath,
            name: propName,
            signature: trimmed,
          }),
        );
        if (/^[A-Z]/.test(propType)) {
          pushUsage(usages, {
            candidateNames: [propType],
            kind: "type",
            line: index + 1,
            ownerSymbol: className,
            rawName: propType,
          });
        }
      }
    }

    /* ── method ────────────────────────────────────────────── */
    const methodMatch = trimmed.match(METHOD_PATTERN);
    if (methodMatch?.[1] && typeStack.length > 0) {
      const name = methodMatch[1];
      if (name !== typeStack[typeStack.length - 1]!.name) {
        const className = typeStack[typeStack.length - 1]!.name;
        const fullName = buildQualifiedName([namespacePath, ...typeStack.map((s) => s.name), name]);
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
    }

    /* ── usages inside methods ─────────────────────────────── */
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

      for (const match of trimmed.matchAll(/\bnew\s+([A-Z][A-Za-z0-9_]*)\s*[(\{]/g)) {
        const typeName = match[1];
        if (!typeName) continue;
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
        if (!methodName || KEYWORDS.has(methodName)) continue;

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
