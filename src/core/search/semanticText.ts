const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CAMEL_BOUNDARY_PATTERN = /([a-z0-9])([A-Z])/g;
const ACRONYM_BOUNDARY_PATTERN = /([A-Z]+)([A-Z][a-z])/g;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "array",
  "async",
  "await",
  "boolean",
  "by",
  "class",
  "const",
  "def",
  "else",
  "enum",
  "export",
  "false",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "interface",
  "internal",
  "let",
  "namespace",
  "new",
  "null",
  "number",
  "object",
  "of",
  "on",
  "or",
  "package",
  "private",
  "protected",
  "public",
  "record",
  "return",
  "self",
  "set",
  "static",
  "string",
  "task",
  "the",
  "this",
  "to",
  "true",
  "using",
  "var",
  "void",
  "with",
]);

const SYNONYM_GROUPS = [
  ["login", "signin", "signon", "auth", "authenticate", "authentication"],
  ["logout", "signout", "signoff"],
  ["handler", "controller", "route", "endpoint", "api"],
  ["service", "manager", "usecase"],
  ["repository", "repo", "dao", "store"],
  ["create", "add", "insert", "save"],
  ["delete", "remove"],
  ["update", "modify", "edit", "patch"],
  ["payment", "pay", "charge", "billing"],
  ["refund", "reimburse", "return"],
  ["config", "configuration", "setting", "settings", "option", "options"],
  ["init", "initialize", "bootstrap", "startup", "start"],
  ["search", "find", "lookup", "query"],
  ["message", "event", "notification"],
  ["user", "account", "member", "profile"],
];

const SYNONYM_MAP = new Map<string, string[]>(
  SYNONYM_GROUPS.flatMap((group) => group.map((term) => [term, group.filter((candidate) => candidate !== term)] as const)),
);

function normalizeToken(token: string): string {
  return token.normalize("NFKC").trim().toLowerCase();
}

function isMeaningfulToken(token: string): boolean {
  if (token.length === 0 || STOP_WORDS.has(token)) {
    return false;
  }

  const codePointLength = [...token].length;
  if (NON_ASCII_PATTERN.test(token)) {
    return codePointLength >= 1;
  }

  return codePointLength >= 2;
}

function splitSegment(rawSegment: string): string[] {
  const normalized = rawSegment
    .normalize("NFKC")
    .replace(CAMEL_BOUNDARY_PATTERN, "$1 $2")
    .replace(ACRONYM_BOUNDARY_PATTERN, "$1 $2")
    .replace(/[_./\\#:-]+/g, " ");

  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeToken)
    .filter(isMeaningfulToken);
}

function buildAdjacentAsciiPairs(parts: string[]): string[] {
  const pairs: string[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const left = parts[index];
    const right = parts[index + 1];
    if (!left || !right || NON_ASCII_PATTERN.test(left) || NON_ASCII_PATTERN.test(right)) {
      continue;
    }

    const combined = `${left}${right}`;
    if (isMeaningfulToken(combined)) {
      pairs.push(combined);
    }
  }

  return pairs;
}

function buildCjkBigrams(token: string): string[] {
  if (!CJK_PATTERN.test(token) || [...token].length < 2) {
    return [];
  }

  const chars = [...token];
  const bigrams: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    const value = `${chars[index]}${chars[index + 1]}`;
    if (isMeaningfulToken(value)) {
      bigrams.push(value);
    }
  }

  return bigrams;
}

function expandSynonyms(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const synonym of SYNONYM_MAP.get(token) ?? []) {
      for (const part of splitSegment(synonym)) {
        expanded.add(part);
      }
    }
  }

  return [...expanded];
}

export function buildSemanticTerms(text: string): string[] {
  const rawSegments = text
    .normalize("NFKC")
    .split(/[\s"'`()[\]{}<>|=+*&!?;,]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const collected = new Set<string>();
  for (const segment of rawSegments) {
    const parts = splitSegment(segment);
    for (const token of parts) {
      collected.add(token);
      for (const bigram of buildCjkBigrams(token)) {
        collected.add(bigram);
      }
    }

    for (const pair of buildAdjacentAsciiPairs(parts)) {
      collected.add(pair);
    }
  }

  return expandSynonyms([...collected]).filter(isMeaningfulToken);
}

export function buildSemanticText(relativePath: string, content: string, symbolNames: string[]): string {
  return [...new Set(buildSemanticTerms([relativePath, ...symbolNames, content].join("\n")))].join(" ");
}

export function buildSemanticFtsQuery(terms: string[]): string | null {
  const filtered = [...new Set(terms.flatMap(splitSegment).filter(isMeaningfulToken))].slice(0, 24);
  return filtered.length > 0 ? filtered.map((term) => `${term}*`).join(" OR ") : null;
}
