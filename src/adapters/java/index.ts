import type { ImportInfo, LanguageAdapter, SourceAnalysis, SymbolInfo, SymbolUsageInfo } from "../../core/common/types.js";
import { buildQualifiedName, createSymbolInfo } from "../helpers.js";

/* ── Patterns ─────────────────────────────────────────────────────── */

const PACKAGE_PATTERN = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/;
const IMPORT_PATTERN = /^\s*import\s+(static\s+)?([A-Za-z_][\w.]*(?:\.\*)?)\s*;/;
const TYPE_PATTERN =
  /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)\b/;
const EXTENDS_IMPLEMENTS_PATTERN =
  /\b(?:extends|implements)\s+([\w.,<>\s?&]+)/g;
const ANNOTATION_LINE_PATTERN = /^\s*@([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:\(|$|\s)/;
const MAPPING_ANNOTATIONS = new Set(["RequestMapping", "GetMapping", "PostMapping", "PutMapping", "DeleteMapping", "PatchMapping"]);
const MAPPING_PATH_PATTERN = /(?:value\s*=\s*)?["']([^"']+)["']/;
const FIELD_PATTERN =
  /^\s*(?:(?:public|private|protected|static|final|volatile|transient)\s+)*([A-Z][\w<>\[\]?,\s]*?)\s+([a-z_]\w*)\s*(?:=|;)/;
const CONSTRUCTOR_PATTERN =
  /^\s*(?:(?:public|private|protected)\s+)?([A-Z]\w*)\s*\(/;
const METHOD_PATTERN =
  /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s*)?[\w<>\[\].,?&\s]+\s+([A-Za-z_]\w*)\s*\(/;
const VARIABLE_INIT_PATTERN =
  /\b([A-Z][A-Za-z0-9_]*)\s+([a-zA-Z_]\w*)\s*=\s*new\s+([A-Z][A-Za-z0-9_]*)\s*\(/;
const METHOD_CALL_PATTERN = /\b(?:(this|super|[A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
const LAMBDA_PATTERN = /(?:\([^)]*\)|[A-Za-z_]\w*)\s*->\s/g;
const METHOD_REF_PATTERN = /([A-Za-z_]\w*)\s*::\s*([A-Za-z_]\w*)/g;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "super", "this"]);

/* ── Helpers ──────────────────────────────────────────────────────── */

interface JavaTypeScope {
  depth: number;
  fieldTypes: Map<string, string>;
  implementsTypes: string[];
  mappingPath?: string;
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

/** Strip generic type parameters and array brackets: `List<String>[]` → `List` */
function stripGenerics(type: string): string {
  return type.replace(/<[^>]*>/g, "").replace(/\[.*?\]/g, "").trim();
}

/** Extract simple class names from an extends/implements clause */
function parseTypeList(clause: string): string[] {
  // Remove generic type params to avoid splitting on commas inside <...>
  let depth = 0;
  let clean = "";
  for (const ch of clause) {
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) clean += ch;
  }
  return clean.split(",").map((s) => s.trim()).filter(Boolean);
}

function isInCommentOrString(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function simpleName(name: string): string {
  return name.split(".").pop() ?? name;
}

function normalizeMappingPath(path: string): string {
  const normalized = path.trim();
  if (!normalized) return "";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function joinMappingPath(prefix: string | undefined, suffix: string | undefined): string | undefined {
  const left = normalizeMappingPath(prefix ?? "");
  const right = normalizeMappingPath(suffix ?? "");
  if (!left && !right) return undefined;
  if (!left) return right;
  if (!right || right === "/") return left;
  return `${left.replace(/\/+$/, "")}/${right.replace(/^\/+/, "")}`;
}

function extractMappingPath(line: string): string | undefined {
  const match = line.match(MAPPING_PATH_PATTERN);
  return match?.[1] ? normalizeMappingPath(match[1]) : undefined;
}

/* ── Main analyser ────────────────────────────────────────────────── */

function analyzeJavaSource(fileId: string, content: string): SourceAnalysis {
  const symbols: SymbolInfo[] = [];
  const imports: ImportInfo[] = [];
  const usages: SymbolUsageInfo[] = [];
  const lines = content.split(/\r?\n/);
  const typeStack: JavaTypeScope[] = [];
  let currentMethod: JavaMethodScope | undefined;
  let braceDepth = 0;
  let packageName = "";
  let pendingTypeName: string | null = null;
  let pendingMappingPath: string | undefined;
  let pendingImplementsTypes: string[] = [];
  /** Map imported simple name → full qualified name */
  const importMap = new Map<string, string>();

  // Multi-line accumulation for signatures that span lines
  let signatureAccum = "";
  let signatureStartLine = -1;

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

    // Skip comments
    if (isInCommentOrString(trimmed)) {
      braceDepth = Math.max(0, braceDepth + countBraces(line));
      continue;
    }

    /* ── package ───────────────────────────────────────────── */
    const packageMatch = trimmed.match(PACKAGE_PATTERN);
    if (packageMatch) {
      packageName = packageMatch[1] ?? "";
    }

    /* ── import ────────────────────────────────────────────── */
    const importMatch = trimmed.match(IMPORT_PATTERN);
    if (importMatch?.[2]) {
      const isStatic = !!importMatch[1];
      const fullImport = importMatch[2];
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
        importMap.set(importedName, fullImport);
        pushUsage(usages, {
          candidateNames: [fullImport, importedName],
          kind: "import",
          line: index + 1,
          rawName: alias,
        });
      }
      if (isStatic) {
        // static import — the method/field is a callable
        pushUsage(usages, {
          candidateNames: [fullImport, importedName],
          kind: "usage",
          line: index + 1,
          rawName: alias,
        });
      }
    }

    /* ── annotations ───────────────────────────────────────── */
    const annoMatch = trimmed.match(ANNOTATION_LINE_PATTERN);
    if (annoMatch?.[1]) {
      const annoName = annoMatch[1];
      const resolvedAnno = importMap.get(annoName) ?? annoName;
      const annoSimpleName = simpleName(annoName);
      const owner = currentMethod?.fullName ?? typeStack[typeStack.length - 1]?.fullName;
      pushUsage(usages, {
        candidateNames: [resolvedAnno, annoName],
        kind: "usage",
        line: index + 1,
        ownerSymbol: owner,
        rawName: `@${annoName}`,
      });
      if (MAPPING_ANNOTATIONS.has(annoSimpleName)) {
        pendingMappingPath = extractMappingPath(trimmed);
      }
    }

    const nextBraceDepth = Math.max(0, braceDepth + countBraces(line));

    /* handle deferred type opening brace */
    if (pendingTypeName && nextBraceDepth > braceDepth) {
      typeStack.push({
        depth: nextBraceDepth,
        fieldTypes: new Map(),
        implementsTypes: pendingImplementsTypes,
        mappingPath: pendingMappingPath,
        fullName: buildQualifiedName([packageName, ...typeStack.map((s) => s.name), pendingTypeName]),
        name: pendingTypeName,
      });
      pendingTypeName = null;
      pendingImplementsTypes = [];
      pendingMappingPath = undefined;
    }

    /* ── type declaration ──────────────────────────────────── */
    const typeMatch = trimmed.match(TYPE_PATTERN);
    if (typeMatch) {
      const rawKind = typeMatch[1];
      const name = typeMatch[2];
      if (rawKind && name) {
        const kind = rawKind === "record" ? "record" : (rawKind as "class" | "enum" | "interface");
        const containerName = typeStack[typeStack.length - 1]?.name;
        const fullName = buildQualifiedName([packageName, ...typeStack.map((s) => s.name), name]);
        const typeMappingPath = pendingMappingPath;
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
        if (typeMappingPath) {
          pushUsage(usages, {
            candidateNames: [typeMappingPath],
            kind: "usage",
            line: index + 1,
            ownerSymbol: fullName,
            rawName: typeMappingPath,
          });
        }

        // extends / implements → type usages
        const implementsTypes: string[] = [];
        for (const eiMatch of trimmed.matchAll(EXTENDS_IMPLEMENTS_PATTERN)) {
          const clause = eiMatch[1];
          if (!clause) continue;
          for (const typeName of parseTypeList(clause)) {
            const simple = stripGenerics(typeName);
            if (!simple) continue;
            const resolved = importMap.get(simple) ?? simple;
            if (trimmed.includes("implements")) {
              implementsTypes.push(resolved, simple);
            }
            pushUsage(usages, {
              candidateNames: [resolved, simple],
              kind: "type",
              line: index + 1,
              ownerSymbol: fullName,
              rawName: simple,
            });
          }
        }

        if (nextBraceDepth > braceDepth) {
          typeStack.push({ depth: nextBraceDepth, fieldTypes: new Map(), fullName, implementsTypes: [...new Set(implementsTypes)], mappingPath: typeMappingPath, name });
          pendingMappingPath = undefined;
        } else if (!trimmed.includes("{")) {
          pendingTypeName = name;
          pendingImplementsTypes = [...new Set(implementsTypes)];
        }
      }
    }

    /* ── constructor ───────────────────────────────────────── */
    const ctorMatch = trimmed.match(CONSTRUCTOR_PATTERN);
    if (ctorMatch && typeStack.length > 0) {
      const ctorName = ctorMatch[1];
      const currentTypeName = typeStack[typeStack.length - 1]!.name;
      if (ctorName && ctorName === currentTypeName && !trimmed.match(METHOD_PATTERN)?.[1]) {
        // Only if it truly looks like a constructor (name == enclosing type)
        const fullName = buildQualifiedName([packageName, ...typeStack.map((s) => s.name), ctorName]);
        // Avoid duplicate if METHOD_PATTERN also matches
        const alreadyAdded = symbols.some((s) => s.line === index + 1 && s.kind === "constructor");
        if (!alreadyAdded) {
          symbols.push(
            createSymbolInfo({
              canonicalName: fullName,
              containerName: currentTypeName,
              fileId,
              fullName,
              kind: "constructor",
              language: "java",
              line: index + 1,
              modulePath: packageName,
              name: ctorName,
              signature: trimmed,
            }),
          );
          currentMethod = {
            className: currentTypeName,
            depth: nextBraceDepth > braceDepth ? nextBraceDepth : braceDepth + 1,
            fullName,
            variableTypes: new Map<string, string>(),
          };
        }
      }
    }

    /* ── method ────────────────────────────────────────────── */
    const methodMatch = trimmed.match(METHOD_PATTERN);
    if (methodMatch && typeStack.length > 0) {
      const name = methodMatch[1];
      if (name && name !== typeStack[typeStack.length - 1]!.name) {
        // Not a constructor (constructor has same name as class, handled above)
        const className = typeStack[typeStack.length - 1]!.name;
        const fullName = buildQualifiedName([packageName, ...typeStack.map((s) => s.name), name]);
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
        const currentType = typeStack[typeStack.length - 1]!;
        const methodMappingPath = pendingMappingPath;
        const fullMappingPath = joinMappingPath(currentType.mappingPath, methodMappingPath);
        if (fullMappingPath) {
          pushUsage(usages, {
            candidateNames: [...new Set([fullMappingPath, methodMappingPath, currentType.mappingPath].filter((value): value is string => Boolean(value)))],
            kind: "usage",
            line: signatureStartLine > 0 ? signatureStartLine : index + 1,
            ownerSymbol: fullName,
            rawName: methodMappingPath ?? fullMappingPath,
          });
        }
        pendingMappingPath = undefined;
        for (const iface of currentType.implementsTypes) {
          const ifaceSimple = simpleName(iface);
          pushUsage(usages, {
            candidateNames: [...new Set([`${iface}.${name}`, `${ifaceSimple}.${name}`, name])],
            kind: "usage",
            line: index + 1,
            ownerSymbol: fullName,
            rawName: `${ifaceSimple}.${name}`,
          });
        }
        currentMethod = {
          className,
          depth: nextBraceDepth > braceDepth ? nextBraceDepth : braceDepth + 1,
          fullName,
          variableTypes: new Map<string, string>(),
        };
      }
    }

    /* ── field (class-level only, outside methods) ─────────── */
    if (!currentMethod && typeStack.length > 0 && !typeMatch && !methodMatch) {
      const fieldMatch = trimmed.match(FIELD_PATTERN);
      if (fieldMatch?.[1] && fieldMatch[2]) {
        const fieldType = stripGenerics(fieldMatch[1]);
        const fieldName = fieldMatch[2];
        const className = typeStack[typeStack.length - 1]!.name;
        const fullName = buildQualifiedName([packageName, ...typeStack.map((s) => s.name), fieldName]);
        symbols.push(
          createSymbolInfo({
            canonicalName: fullName,
            containerName: className,
            fileId,
            fullName,
            kind: "field",
            language: "java",
            line: index + 1,
            modulePath: packageName,
            name: fieldName,
            signature: trimmed.replace(/\s*=.*/, ";").trim(),
          }),
        );
        // field type → type usage
        const resolvedType = importMap.get(fieldType) ?? fieldType;
        if (/^[A-Z]/.test(fieldType)) {
          typeStack[typeStack.length - 1]!.fieldTypes.set(fieldName, fieldType);
          pushUsage(usages, {
            candidateNames: [resolvedType, fieldType],
            kind: "type",
            line: index + 1,
            ownerSymbol: typeStack[typeStack.length - 1]!.fullName,
            rawName: fieldType,
          });
        }
      }
    }

    /* ── usages inside methods ─────────────────────────────── */
    if (currentMethod) {
      const variableMatch = trimmed.match(VARIABLE_INIT_PATTERN);
      if (variableMatch?.[2] && variableMatch[3]) {
        const variableType = variableMatch[3];
        currentMethod.variableTypes.set(variableMatch[2], variableType);
        pushUsage(usages, {
          candidateNames: [importMap.get(variableType) ?? variableType, variableType],
          kind: "instantiation",
          line: index + 1,
          ownerSymbol: currentMethod.fullName,
          rawName: variableType,
        });
      }

      // Also track typed local vars without `new`
      const localVarMatch = trimmed.match(/^\s*([A-Z][\w<>\[\]?,\s]*?)\s+([a-z_]\w*)\s*(?:=|;)/);
      if (localVarMatch?.[1] && localVarMatch[2]) {
        const lvType = stripGenerics(localVarMatch[1]);
        if (/^[A-Z]/.test(lvType) && !currentMethod.variableTypes.has(localVarMatch[2])) {
          currentMethod.variableTypes.set(localVarMatch[2], lvType);
        }
      }

      const newMatches = [...trimmed.matchAll(/\bnew\s+([A-Z][A-Za-z0-9_]*)\s*\(/g)];
      for (const match of newMatches) {
        const typeName = match[1];
        if (!typeName) continue;
        pushUsage(usages, {
          candidateNames: [importMap.get(typeName) ?? typeName, typeName],
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
        } else if (receiver === "this" || receiver === "super") {
          candidateNames.unshift(`${currentMethod.className}.${methodName}`);
        } else if (currentMethod.variableTypes.has(receiver)) {
          const recvType = currentMethod.variableTypes.get(receiver)!;
          candidateNames.unshift(`${recvType}.${methodName}`);
          // Also try with import-resolved type
          const resolvedRecvType = importMap.get(recvType);
          if (resolvedRecvType) candidateNames.unshift(`${resolvedRecvType}.${methodName}`);
        } else if (typeStack[typeStack.length - 1]?.fieldTypes.has(receiver)) {
          const recvType = typeStack[typeStack.length - 1]!.fieldTypes.get(receiver)!;
          candidateNames.unshift(`${recvType}.${methodName}`);
          const resolvedRecvType = importMap.get(recvType);
          if (resolvedRecvType) candidateNames.unshift(`${resolvedRecvType}.${methodName}`);
        } else if (/^[A-Z]/.test(receiver)) {
          candidateNames.unshift(`${receiver}.${methodName}`);
          const resolvedReceiver = importMap.get(receiver);
          if (resolvedReceiver) candidateNames.unshift(`${resolvedReceiver}.${methodName}`);
        }

        pushUsage(usages, {
          candidateNames,
          kind: "call",
          line: index + 1,
          ownerSymbol: currentMethod.fullName,
          rawName: receiver ? `${receiver}.${methodName}` : methodName,
        });
      }

      // Method references: ClassName::methodName, this::methodName, var::methodName
      for (const match of trimmed.matchAll(METHOD_REF_PATTERN)) {
        const receiver = match[1];
        const methodName = match[2];
        if (!methodName || KEYWORDS.has(methodName) || !receiver) continue;

        const candidateNames = [methodName];
        if (receiver === "this" || receiver === "super") {
          candidateNames.unshift(`${currentMethod.className}.${methodName}`);
        } else if (currentMethod.variableTypes.has(receiver)) {
          const recvType = currentMethod.variableTypes.get(receiver)!;
          candidateNames.unshift(`${recvType}.${methodName}`);
          const resolvedRecvType = importMap.get(recvType);
          if (resolvedRecvType) candidateNames.unshift(`${resolvedRecvType}.${methodName}`);
        } else if (/^[A-Z]/.test(receiver)) {
          candidateNames.unshift(`${receiver}.${methodName}`);
          const resolvedReceiver = importMap.get(receiver);
          if (resolvedReceiver) candidateNames.unshift(`${resolvedReceiver}.${methodName}`);
        }

        pushUsage(usages, {
          candidateNames,
          kind: "call",
          line: index + 1,
          ownerSymbol: currentMethod.fullName,
          rawName: `${receiver}::${methodName}`,
        });
      }

      // Lambda expressions: extract method calls inside lambda bodies
      // e.g. list.forEach(item -> process(item)) — the `process(item)` call
      if (LAMBDA_PATTERN.test(trimmed)) {
        // Reset regex state for nested matches
        for (const callMatch of trimmed.matchAll(METHOD_CALL_PATTERN)) {
          const receiver = callMatch[1];
          const methodName = callMatch[2];
          if (!methodName || KEYWORDS.has(methodName)) continue;
          const key = `${receiver ?? ""}.${methodName}:${index + 1}`;
          const alreadyTracked = usages.some(
            (u) => u.line === index + 1 && u.kind === "call" && u.rawName === (receiver ? `${receiver}.${methodName}` : methodName),
          );
          if (alreadyTracked) continue;

          const candidateNames = [methodName];
          if (receiver === "this" || receiver === "super") {
            candidateNames.unshift(`${currentMethod.className}.${methodName}`);
          } else if (receiver && currentMethod.variableTypes.has(receiver)) {
            const recvType = currentMethod.variableTypes.get(receiver)!;
            candidateNames.unshift(`${recvType}.${methodName}`);
          } else if (receiver && /^[A-Z]/.test(receiver)) {
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
