import ts from "typescript";

import type { LanguageAdapter, SymbolInfo } from "../../core/common/types.js";
import { buildStableId } from "../../core/indexing/fileFingerprint.js";

const MAX_SIGNATURE_LENGTH = 240;

function buildFullName(containers: string[], name: string): string {
  return containers.length > 0 ? `${containers.join(".")}.${name}` : name;
}

function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function getDeclarationName(sourceFile: ts.SourceFile, name: ts.BindingName | ts.PropertyName | undefined): string | null {
  if (!name) {
    return null;
  }

  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }

  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (ts.isIdentifier(expression) || ts.isPrivateIdentifier(expression)) {
      return expression.text;
    }

    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
      return expression.text;
    }
  }

  const text = name.getText(sourceFile).trim();
  return text.length > 0 ? text : null;
}

function buildSignature(sourceFile: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(sourceFile).replace(/\s+/g, " ").trim();
  return text.length <= MAX_SIGNATURE_LENGTH ? text : `${text.slice(0, MAX_SIGNATURE_LENGTH - 3)}...`;
}

function addSymbol(
  symbols: Map<string, SymbolInfo>,
  sourceFile: ts.SourceFile,
  fileId: string,
  kind: SymbolInfo["kind"],
  name: string,
  containers: string[],
  node: ts.Node,
): void {
  const line = getLineNumber(sourceFile, node);
  const fullName = buildFullName(containers, name);
  const key = `${kind}:${fullName}:${line}`;
  if (symbols.has(key)) {
    return;
  }

  symbols.set(key, {
    fileId,
    fullName,
    kind,
    line,
    name,
    signature: buildSignature(sourceFile, node),
    symbolId: buildStableId([fileId, "javascript", kind, fullName, String(line)]),
  });
}

function walkObjectMembers(
  members: readonly ts.ObjectLiteralElementLike[],
  containers: string[],
  visit: (node: ts.Node, containers: string[]) => void,
): void {
  for (const member of members) {
    visit(member, containers);
  }
}

function extractSymbolsWithAst(fileId: string, content: string): SymbolInfo[] {
  const sourceFile = ts.createSourceFile("source.tsx", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const symbols = new Map<string, SymbolInfo>();

  const visit = (node: ts.Node, containers: string[]): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = getDeclarationName(sourceFile, node.name);
      if (className) {
        addSymbol(symbols, sourceFile, fileId, "class", className, containers, node);
        for (const member of node.members) {
          visit(member, [...containers, className]);
        }
        return;
      }
    }

    if (ts.isInterfaceDeclaration(node)) {
      const interfaceName = getDeclarationName(sourceFile, node.name);
      if (interfaceName) {
        addSymbol(symbols, sourceFile, fileId, "interface", interfaceName, containers, node);
        for (const member of node.members) {
          visit(member, [...containers, interfaceName]);
        }
        return;
      }
    }

    if (ts.isEnumDeclaration(node)) {
      const enumName = getDeclarationName(sourceFile, node.name);
      if (enumName) {
        addSymbol(symbols, sourceFile, fileId, "enum", enumName, containers, node);
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const functionName = getDeclarationName(sourceFile, node.name);
      if (functionName) {
        addSymbol(symbols, sourceFile, fileId, "function", functionName, containers, node);
        ts.forEachChild(node, (child) => visit(child, [...containers, functionName]));
        return;
      }
    }

    if (
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      const methodName = getDeclarationName(sourceFile, node.name);
      if (methodName && containers.length > 0) {
        addSymbol(symbols, sourceFile, fileId, "method", methodName, containers, node);
        ts.forEachChild(node, (child) => visit(child, [...containers, methodName]));
        return;
      }
    }

    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      const propertyName = getDeclarationName(sourceFile, node.name);
      if (propertyName && containers.length > 0) {
        const initializer = ts.isPropertyDeclaration(node) ? node.initializer : undefined;
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          addSymbol(symbols, sourceFile, fileId, "method", propertyName, containers, node);
          ts.forEachChild(initializer, (child) => visit(child, [...containers, propertyName]));
          return;
        }

        if (node.type && ts.isFunctionTypeNode(node.type)) {
          addSymbol(symbols, sourceFile, fileId, "method", propertyName, containers, node);
          return;
        }

        if (initializer && ts.isObjectLiteralExpression(initializer)) {
          walkObjectMembers(initializer.properties, [...containers, propertyName], visit);
          return;
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const variableName = node.name.text;
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        addSymbol(symbols, sourceFile, fileId, "function", variableName, containers, node);
        ts.forEachChild(node.initializer, (child) => visit(child, [...containers, variableName]));
        return;
      }

      if (ts.isClassExpression(node.initializer)) {
        addSymbol(symbols, sourceFile, fileId, "class", variableName, containers, node);
        for (const member of node.initializer.members) {
          visit(member, [...containers, variableName]);
        }
        return;
      }

      if (ts.isObjectLiteralExpression(node.initializer)) {
        walkObjectMembers(node.initializer.properties, [...containers, variableName], visit);
        return;
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const propertyName = getDeclarationName(sourceFile, node.name);
      if (propertyName && containers.length > 0) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
          addSymbol(symbols, sourceFile, fileId, "method", propertyName, containers, node);
          ts.forEachChild(node.initializer, (child) => visit(child, [...containers, propertyName]));
          return;
        }

        if (ts.isClassExpression(node.initializer)) {
          addSymbol(symbols, sourceFile, fileId, "class", propertyName, containers, node);
          for (const member of node.initializer.members) {
            visit(member, [...containers, propertyName]);
          }
          return;
        }

        if (ts.isObjectLiteralExpression(node.initializer)) {
          walkObjectMembers(node.initializer.properties, [...containers, propertyName], visit);
          return;
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, containers));
  };

  visit(sourceFile, []);
  return [...symbols.values()].sort((left, right) => left.line - right.line || left.fullName.localeCompare(right.fullName));
}

export const javascriptAdapter: LanguageAdapter = {
  extractSymbols(fileId, content) {
    return extractSymbolsWithAst(fileId, content);
  },
  language: "javascript",
  projectMarkerPatterns: [/^package\.json$/i, /^tsconfig\.json$/i],
  sourceExtensions: [".js", ".jsx", ".ts", ".tsx"],
};
