import type { StructuredSearchField, StructuredSearchOperator } from "../common/types.js";
import { AppError } from "../common/errors.js";

type Token =
  | { type: "AND" | "LPAREN" | "NOT" | "OR" | "RPAREN" }
  | { field?: StructuredSearchField; phrase: boolean; type: "TERM"; value: string };

export type StructuredQueryNode =
  | { left: StructuredQueryNode; right: StructuredQueryNode; type: "and" | "or" }
  | { operand: StructuredQueryNode; type: "not" }
  | { field?: StructuredSearchField; phrase: boolean; termId: string; type: "term"; value: string };

export interface StructuredQueryTerm {
  field?: StructuredSearchField;
  phrase: boolean;
  termId: string;
  value: string;
}

export interface ParsedStructuredQuery {
  fields: StructuredSearchField[];
  operators: StructuredSearchOperator[];
  root: StructuredQueryNode;
  terms: StructuredQueryTerm[];
}

const FIELD_NAMES = new Set<StructuredSearchField>(["content", "path", "symbol"]);
const STRUCTURED_SYNTAX_PATTERN = /\b(?:AND|OR|NOT)\b|(?:^|[\s(])(?:content|path|symbol):|[()]/i;

function readQuotedValue(input: string, start: number): { end: number; phrase: true; value: string } {
  let current = start + 1;
  let value = "";

  while (current < input.length) {
    const character = input[current]!;
    if (character === "\\" && current + 1 < input.length) {
      value += input[current + 1]!;
      current += 2;
      continue;
    }

    if (character === "\"") {
      return {
        end: current + 1,
        phrase: true,
        value,
      };
    }

    value += character;
    current += 1;
  }

  throw new AppError("INVALID_STRUCTURED_QUERY", "Unterminated quoted phrase in structured query.");
}

function readBareValue(input: string, start: number): { end: number; phrase: false; value: string } {
  let current = start;
  let value = "";
  while (current < input.length) {
    const character = input[current]!;
    if (/\s/.test(character) || character === "(" || character === ")") {
      break;
    }
    value += character;
    current += 1;
  }

  return {
    end: current,
    phrase: false,
    value,
  };
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const character = input[cursor]!;
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }

    if (character === "(") {
      tokens.push({ type: "LPAREN" });
      cursor += 1;
      continue;
    }

    if (character === ")") {
      tokens.push({ type: "RPAREN" });
      cursor += 1;
      continue;
    }

    let field: StructuredSearchField | undefined;
    const remaining = input.slice(cursor);
    const fieldMatch = /^(content|path|symbol):/i.exec(remaining);
    if (fieldMatch) {
      field = fieldMatch[1]!.toLowerCase() as StructuredSearchField;
      cursor += fieldMatch[0].length;
      if (cursor >= input.length) {
        throw new AppError("INVALID_STRUCTURED_QUERY", `Missing value for ${field}: clause.`);
      }
    }

    const valueToken =
      input[cursor] === "\""
        ? readQuotedValue(input, cursor)
        : readBareValue(input, cursor);
    cursor = valueToken.end;
    const value = valueToken.value.trim();
    if (value.length === 0) {
      throw new AppError("INVALID_STRUCTURED_QUERY", "Structured query contains an empty clause.");
    }

    if (!field && !valueToken.phrase) {
      const upperValue = value.toUpperCase();
      if (upperValue === "AND" || upperValue === "OR" || upperValue === "NOT") {
        tokens.push({ type: upperValue });
        continue;
      }
    }

    tokens.push({
      field,
      phrase: valueToken.phrase,
      type: "TERM",
      value,
    });
  }

  return tokens;
}

function canStartUnary(token: Token | undefined): boolean {
  return token?.type === "TERM" || token?.type === "LPAREN" || token?.type === "NOT";
}

export function isStructuredQuery(query: string): boolean {
  return STRUCTURED_SYNTAX_PATTERN.test(query);
}

export function parseStructuredQuery(query: string): ParsedStructuredQuery | null {
  if (!isStructuredQuery(query)) {
    return null;
  }

  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return null;
  }

  let position = 0;
  const terms: StructuredQueryTerm[] = [];
  const operators = new Set<StructuredSearchOperator>();
  const fields = new Set<StructuredSearchField>();

  function peek(): Token | undefined {
    return tokens[position];
  }

  function consume(expected?: Token["type"]): Token {
    const token = tokens[position];
    if (!token) {
      throw new AppError("INVALID_STRUCTURED_QUERY", "Unexpected end of structured query.");
    }
    if (expected && token.type !== expected) {
      throw new AppError("INVALID_STRUCTURED_QUERY", `Expected ${expected} but found ${token.type}.`);
    }
    position += 1;
    return token;
  }

  function parsePrimary(): StructuredQueryNode {
    const token = peek();
    if (!token) {
      throw new AppError("INVALID_STRUCTURED_QUERY", "Unexpected end of structured query.");
    }

    if (token.type === "LPAREN") {
      consume("LPAREN");
      const node = parseOr();
      consume("RPAREN");
      return node;
    }

    if (token.type !== "TERM") {
      throw new AppError("INVALID_STRUCTURED_QUERY", `Unexpected token ${token.type} in structured query.`);
    }

    const consumed = consume("TERM") as Extract<Token, { type: "TERM" }>;
    const termId = `term-${terms.length + 1}`;
    const term: StructuredQueryTerm = {
      field: consumed.field,
      phrase: consumed.phrase,
      termId,
      value: consumed.value,
    };
    terms.push(term);
    if (consumed.field) {
      fields.add(consumed.field);
    }

    return {
      field: consumed.field,
      phrase: consumed.phrase,
      termId,
      type: "term",
      value: consumed.value,
    };
  }

  function parseUnary(): StructuredQueryNode {
    const token = peek();
    if (token?.type === "NOT") {
      consume("NOT");
      operators.add("NOT");
      return {
        operand: parseUnary(),
        type: "not",
      };
    }

    return parsePrimary();
  }

  function parseAnd(): StructuredQueryNode {
    let node = parseUnary();
    while (true) {
      const token = peek();
      if (token?.type === "AND") {
        consume("AND");
        operators.add("AND");
        node = {
          left: node,
          right: parseUnary(),
          type: "and",
        };
        continue;
      }

      if (canStartUnary(token)) {
        operators.add("AND");
        node = {
          left: node,
          right: parseUnary(),
          type: "and",
        };
        continue;
      }

      break;
    }

    return node;
  }

  function parseOr(): StructuredQueryNode {
    let node = parseAnd();
    while (peek()?.type === "OR") {
      consume("OR");
      operators.add("OR");
      node = {
        left: node,
        right: parseAnd(),
        type: "or",
      };
    }

    return node;
  }

  const root = parseOr();
  if (position !== tokens.length) {
    throw new AppError("INVALID_STRUCTURED_QUERY", `Unexpected token ${tokens[position]!.type} in structured query.`);
  }

  for (const term of terms) {
    if (term.field && !FIELD_NAMES.has(term.field)) {
      throw new AppError("INVALID_STRUCTURED_QUERY", `Unsupported structured query field: ${term.field}`);
    }
  }

  return {
    fields: [...fields],
    operators: [...operators],
    root,
    terms,
  };
}

export function collectPositiveStructuredTerms(
  node: StructuredQueryNode,
  negated = false,
  collected: Set<string> = new Set(),
): Set<string> {
  if (node.type === "term") {
    if (!negated) {
      collected.add(node.termId);
    }
    return collected;
  }

  if (node.type === "not") {
    return collectPositiveStructuredTerms(node.operand, !negated, collected);
  }

  collectPositiveStructuredTerms(node.left, negated, collected);
  collectPositiveStructuredTerms(node.right, negated, collected);
  return collected;
}
