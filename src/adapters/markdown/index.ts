import { buildModulePath, createSymbolInfo } from "../helpers.js";
import type { LanguageAdapter, SourceAnalysis, SymbolInfo, SymbolUsageInfo } from "../../core/common/types.js";

const HEADING_PATTERN = /^(#{1,6})[ \t]+(.+?)\s*$/;
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;
const DOTTED_IDENTIFIER_PATTERN = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g;
const IDENTIFIER_PATTERN = /\b[A-Za-z_$][\w$]*\b/g;
const MAX_CODE_USAGES_PER_FILE = 2_000;

const CODE_KEYWORDS = new Set([
  "abstract",
  "and",
  "as",
  "async",
  "await",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "delegate",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "internal",
  "is",
  "let",
  "namespace",
  "new",
  "none",
  "not",
  "null",
  "or",
  "out",
  "override",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "record",
  "return",
  "sealed",
  "self",
  "static",
  "string",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "undefined",
  "using",
  "var",
  "void",
  "while",
  "yield",
]);

interface HeadingScope {
  level: number;
  name: string;
  slug: string;
}

interface FenceState {
  char: "`" | "~";
  length: number;
}

function normalizeHeadingText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\\([\\`*_[\]{}()#+\-.!])/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyHeading(name: string, line: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `section-${line}`;
}

function parseFence(line: string): FenceState | null {
  const match = line.match(FENCE_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  return {
    char: match[1][0] as "`" | "~",
    length: match[1].length,
  };
}

function closesFence(line: string, fence: FenceState): boolean {
  const match = line.match(FENCE_PATTERN);
  return Boolean(match?.[1] && match[1][0] === fence.char && match[1].length >= fence.length);
}

function isCodeIdentifier(value: string): boolean {
  const normalized = value.toLowerCase();
  return value.length > 1 && !CODE_KEYWORDS.has(normalized);
}

function dedupeCandidates(values: string[]): string[] {
  return [...new Set(values.filter(isCodeIdentifier))];
}

function pushCodeUsage(
  usages: SymbolUsageInfo[],
  seen: Set<string>,
  rawName: string,
  candidateNames: string[],
  line: number,
): void {
  if (usages.length >= MAX_CODE_USAGES_PER_FILE || !isCodeIdentifier(rawName.split(".").pop() ?? rawName)) {
    return;
  }

  const candidates = dedupeCandidates(candidateNames);
  if (candidates.length === 0) {
    return;
  }

  const key = `${line}:${rawName}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  usages.push({
    candidateNames: candidates,
    kind: "usage",
    line,
    rawName,
  });
}

function extractCodeLineUsages(line: string, lineNumber: number, usages: SymbolUsageInfo[], seen: Set<string>): void {
  const dottedRanges: Array<{ end: number; start: number }> = [];

  for (const match of line.matchAll(DOTTED_IDENTIFIER_PATTERN)) {
    const rawName = match[0];
    const start = match.index ?? 0;
    dottedRanges.push({ end: start + rawName.length, start });
    const parts = rawName.split(".");
    const leafName = parts[parts.length - 1] ?? rawName;
    pushCodeUsage(usages, seen, rawName, [rawName, leafName], lineNumber);
  }

  for (const match of line.matchAll(IDENTIFIER_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (dottedRanges.some((range) => start >= range.start && end <= range.end)) {
      continue;
    }

    const rawName = match[0];
    pushCodeUsage(usages, seen, rawName, [rawName], lineNumber);
  }
}

function analyzeMarkdownSource(fileId: string, relativePath: string, content: string): SourceAnalysis {
  const modulePath = buildModulePath(relativePath);
  const symbols: SymbolInfo[] = [];
  const usages: SymbolUsageInfo[] = [];
  const usageKeys = new Set<string>();
  const headingStack: HeadingScope[] = [];
  let fence: FenceState | null = null;

  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
        continue;
      }
      extractCodeLineUsages(line, lineNumber, usages, usageKeys);
      continue;
    }

    const openedFence = parseFence(line);
    if (openedFence) {
      fence = openedFence;
      continue;
    }

    const headingMatch = line.match(HEADING_PATTERN);
    if (!headingMatch?.[1] || !headingMatch[2]) {
      continue;
    }

    const level = headingMatch[1].length;
    const name = normalizeHeadingText(headingMatch[2]);
    if (!name) {
      continue;
    }

    while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
      headingStack.pop();
    }

    const parent = headingStack[headingStack.length - 1];
    const slug = slugifyHeading(name, lineNumber);
    const fullName = [...headingStack.map((item) => item.name), name].join(".");
    const canonicalName = `${modulePath}#${[...headingStack.map((item) => item.slug), slug].join(".")}`;
    symbols.push(
      createSymbolInfo({
        canonicalName,
        containerName: parent?.name,
        fileId,
        fullName,
        kind: "section",
        language: "markdown",
        line: lineNumber,
        modulePath,
        name,
        signature: line.trim(),
      }),
    );

    headingStack.push({ level, name, slug });
  }

  return {
    imports: [],
    symbols,
    usages,
  };
}

export const markdownAdapter: LanguageAdapter = {
  analyzeSource(fileId, relativePath, content) {
    return analyzeMarkdownSource(fileId, relativePath, content);
  },
  extractSymbols(fileId, content) {
    return analyzeMarkdownSource(fileId, "source.md", content).symbols;
  },
  language: "markdown",
  projectMarkerPatterns: [],
  sourceExtensions: [".md", ".mdx"],
};
