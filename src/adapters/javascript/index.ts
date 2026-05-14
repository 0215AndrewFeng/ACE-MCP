import path from "node:path";

import ts from "typescript";

import type { ImportInfo, LanguageAdapter, SourceAnalysis, SymbolInfo, SymbolUsageInfo } from "../../core/common/types.js";
import { buildStableId } from "../../core/indexing/fileFingerprint.js";
import { buildModulePath, normalizeSignature } from "../helpers.js";

function buildFullName(containers: string[], name: string): string {
  return containers.length > 0 ? `${containers.join(".")}.${name}` : name;
}

function buildCanonicalName(modulePath: string, fullName: string): string {
  return modulePath.length > 0 ? `${modulePath}#${fullName}` : fullName;
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
  return normalizeSignature(node.getText(sourceFile));
}

function buildImportModulePath(relativePath: string, specifier: string): string {
  if (specifier.startsWith(".")) {
    const directory = path.posix.dirname(relativePath.replace(/\\/g, "/"));
    return buildModulePath(path.posix.normalize(path.posix.join(directory, specifier)));
  }

  return specifier;
}

interface JSImportBinding extends ImportInfo {
  namespace: boolean;
}

interface VisitState {
  classStack: string[];
  currentSymbol?: string;
  variableTypes: Map<string, string>;
}

function dedupeCandidateNames(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function pushUsage(
  usages: SymbolUsageInfo[],
  usage: SymbolUsageInfo,
): void {
  if (usage.candidateNames.length === 0 && usage.rawName.trim().length === 0) {
    return;
  }

  usages.push({
    ...usage,
    candidateNames: dedupeCandidateNames(usage.candidateNames),
  });
}

function getPropertyAccessText(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression) || ts.isPrivateIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const left = getPropertyAccessText(expression.expression);
    return left ? `${left}.${expression.name.text}` : expression.name.text;
  }

  return null;
}

function getTypeNameFromExpression(
  expression: ts.Expression | undefined,
  imports: Map<string, JSImportBinding>,
): string | undefined {
  if (!expression) {
    return undefined;
  }

  if (ts.isIdentifier(expression)) {
    const imported = imports.get(expression.text);
    if (imported) {
      return imported.importedName === "default" ? expression.text : imported.importedName;
    }

    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const propertyText = getPropertyAccessText(expression);
    if (!propertyText) {
      return undefined;
    }

    const parts = propertyText.split(".");
    return parts[parts.length - 1];
  }

  return undefined;
}

function analyzeSourceWithAst(fileId: string, relativePath: string, content: string): SourceAnalysis {
  const scriptKind = relativePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : relativePath.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : relativePath.endsWith(".js") || relativePath.endsWith(".mjs") || relativePath.endsWith(".cjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, scriptKind);
  const modulePath = buildModulePath(relativePath);
  const symbols = new Map<string, SymbolInfo>();
  const imports: ImportInfo[] = [];
  const usages: SymbolUsageInfo[] = [];
  const importBindings = new Map<string, JSImportBinding>();

  const addSymbol = (
    kind: SymbolInfo["kind"],
    name: string,
    containers: string[],
    node: ts.Node,
  ): string => {
    const line = getLineNumber(sourceFile, node);
    const fullName = buildFullName(containers, name);
    const key = `${kind}:${fullName}:${line}`;
    if (!symbols.has(key)) {
      symbols.set(key, {
        canonicalName: buildCanonicalName(modulePath, fullName),
        containerName: containers[containers.length - 1],
        fileId,
        fullName,
        kind,
        line,
        modulePath,
        name,
        signature: buildSignature(sourceFile, node),
        symbolId: buildStableId([fileId, "javascript", kind, fullName, String(line)]),
      });
    }

    return fullName;
  };

  const visit = (node: ts.Node, state: VisitState): void => {
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteral(node.moduleSpecifier)) {
      const sourceModule = buildImportModulePath(relativePath, node.moduleSpecifier.text);
      if (node.importClause.name) {
        const alias = node.importClause.name.text;
        const importInfo: JSImportBinding = {
          alias,
          importedName: "default",
          line: getLineNumber(sourceFile, node),
          namespace: false,
          sourceModule,
        };
        imports.push(importInfo);
        importBindings.set(alias, importInfo);
        pushUsage(usages, {
          candidateNames: [alias],
          kind: "import",
          line: importInfo.line,
          rawName: alias,
        });
      }

      const namedBindings = node.importClause.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const alias = element.name.text;
          const importedName = element.propertyName?.text ?? element.name.text;
          const importInfo: JSImportBinding = {
            alias,
            importedName,
            line: getLineNumber(sourceFile, element),
            namespace: false,
            sourceModule,
          };
          imports.push(importInfo);
          importBindings.set(alias, importInfo);
          pushUsage(usages, {
            candidateNames: [importedName, alias],
            kind: "import",
            line: importInfo.line,
            rawName: alias,
          });
        }
      } else if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        const alias = namedBindings.name.text;
        const importInfo: JSImportBinding = {
          alias,
          importedName: "*",
          line: getLineNumber(sourceFile, namedBindings),
          namespace: true,
          sourceModule,
        };
        imports.push(importInfo);
        importBindings.set(alias, importInfo);
      }

      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const className = getDeclarationName(sourceFile, node.name);
      if (className) {
        const nextState: VisitState = {
          classStack: [...state.classStack, className],
          currentSymbol: state.currentSymbol,
          variableTypes: new Map(state.variableTypes),
        };
        addSymbol("class", className, state.classStack, node);
        for (const member of node.members) {
          visit(member, nextState);
        }
        return;
      }
    }

    if (ts.isInterfaceDeclaration(node)) {
      const interfaceName = getDeclarationName(sourceFile, node.name);
      if (interfaceName) {
        addSymbol("interface", interfaceName, state.classStack, node);
        for (const member of node.members) {
          visit(member, {
            ...state,
            classStack: [...state.classStack, interfaceName],
            variableTypes: new Map(state.variableTypes),
          });
        }
        return;
      }
    }

    if (ts.isEnumDeclaration(node)) {
      const enumName = getDeclarationName(sourceFile, node.name);
      if (enumName) {
        addSymbol("enum", enumName, state.classStack, node);
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const functionName = getDeclarationName(sourceFile, node.name);
      if (functionName) {
        const fullName = addSymbol("function", functionName, state.classStack, node);
        const nextState: VisitState = {
          classStack: state.classStack,
          currentSymbol: fullName,
          variableTypes: new Map(state.variableTypes),
        };
        ts.forEachChild(node, (child) => visit(child, nextState));
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
      if (methodName && state.classStack.length > 0) {
        const fullName = addSymbol("method", methodName, state.classStack, node);
        const nextState: VisitState = {
          classStack: state.classStack,
          currentSymbol: fullName,
          variableTypes: new Map(state.variableTypes),
        };
        ts.forEachChild(node, (child) => visit(child, nextState));
        return;
      }
    }

    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      const propertyName = getDeclarationName(sourceFile, node.name);
      if (propertyName && state.classStack.length > 0) {
        const initializer = ts.isPropertyDeclaration(node) ? node.initializer : undefined;
        if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          const fullName = addSymbol("method", propertyName, state.classStack, node);
          const nextState: VisitState = {
            classStack: state.classStack,
            currentSymbol: fullName,
            variableTypes: new Map(state.variableTypes),
          };
          ts.forEachChild(initializer, (child) => visit(child, nextState));
          return;
        }

        if (initializer && ts.isObjectLiteralExpression(initializer)) {
          for (const member of initializer.properties) {
            visit(member, {
              ...state,
              classStack: [...state.classStack, propertyName],
              variableTypes: new Map(state.variableTypes),
            });
          }
          return;
        }

        if (node.type && ts.isFunctionTypeNode(node.type)) {
          addSymbol("method", propertyName, state.classStack, node);
          return;
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const variableName = node.name.text;
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        const fullName = addSymbol("function", variableName, state.classStack, node);
        const nextState: VisitState = {
          classStack: state.classStack,
          currentSymbol: fullName,
          variableTypes: new Map(state.variableTypes),
        };
        ts.forEachChild(node.initializer, (child) => visit(child, nextState));
        return;
      }

      if (ts.isClassExpression(node.initializer)) {
        addSymbol("class", variableName, state.classStack, node);
        for (const member of node.initializer.members) {
          visit(member, {
            ...state,
            classStack: [...state.classStack, variableName],
            variableTypes: new Map(state.variableTypes),
          });
        }
        return;
      }

      if (ts.isObjectLiteralExpression(node.initializer)) {
        for (const member of node.initializer.properties) {
          visit(member, {
            ...state,
            classStack: [...state.classStack, variableName],
            variableTypes: new Map(state.variableTypes),
          });
        }
        return;
      }

      if (ts.isNewExpression(node.initializer)) {
        const typeName = getTypeNameFromExpression(node.initializer.expression, importBindings);
        if (typeName) {
          state.variableTypes.set(variableName, typeName);
          pushUsage(usages, {
            candidateNames: [typeName],
            kind: "instantiation",
            line: getLineNumber(sourceFile, node.initializer),
            ownerSymbol: state.currentSymbol,
            rawName: typeName,
          });
        }
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const propertyName = getDeclarationName(sourceFile, node.name);
      if (propertyName && state.classStack.length > 0) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
          const fullName = addSymbol("method", propertyName, state.classStack, node);
          const nextState: VisitState = {
            classStack: state.classStack,
            currentSymbol: fullName,
            variableTypes: new Map(state.variableTypes),
          };
          ts.forEachChild(node.initializer, (child) => visit(child, nextState));
          return;
        }

        if (ts.isClassExpression(node.initializer)) {
          addSymbol("class", propertyName, state.classStack, node);
          for (const member of node.initializer.members) {
            visit(member, {
              ...state,
              classStack: [...state.classStack, propertyName],
              variableTypes: new Map(state.variableTypes),
            });
          }
          return;
        }

        if (ts.isObjectLiteralExpression(node.initializer)) {
          for (const member of node.initializer.properties) {
            visit(member, {
              ...state,
              classStack: [...state.classStack, propertyName],
              variableTypes: new Map(state.variableTypes),
            });
          }
          return;
        }
      }
    }

    if (ts.isHeritageClause(node)) {
      for (const type of node.types) {
        const name = type.expression.getText(sourceFile).trim();
        if (name.length > 0) {
          pushUsage(usages, {
            candidateNames: [name],
            kind: "type",
            line: getLineNumber(sourceFile, type),
            ownerSymbol: state.currentSymbol,
            rawName: name,
          });
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const typeName = getTypeNameFromExpression(node.expression, importBindings);
      if (typeName) {
        pushUsage(usages, {
          candidateNames: [typeName],
          kind: "instantiation",
          line: getLineNumber(sourceFile, node),
          ownerSymbol: state.currentSymbol,
          rawName: typeName,
        });
      }
    }

    if (ts.isCallExpression(node)) {
      const line = getLineNumber(sourceFile, node);
      if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const imported = importBindings.get(name);
        pushUsage(usages, {
          candidateNames: dedupeCandidateNames([
            state.classStack[state.classStack.length - 1] ? `${state.classStack[state.classStack.length - 1]}.${name}` : undefined,
            imported?.importedName && imported.importedName !== "default" && imported.importedName !== "*" ? imported.importedName : undefined,
            name,
          ]),
          kind: "call",
          line,
          ownerSymbol: state.currentSymbol,
          rawName: name,
        });
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const propertyName = node.expression.name.text;
        const receiverText = getPropertyAccessText(node.expression.expression);
        const receiverIdentifier = ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : undefined;
        const imported = receiverIdentifier ? importBindings.get(receiverIdentifier) : undefined;
        const receiverType = receiverIdentifier ? state.variableTypes.get(receiverIdentifier) : undefined;
        const isThisReceiver = node.expression.expression.kind === ts.SyntaxKind.ThisKeyword;
        pushUsage(usages, {
          candidateNames: dedupeCandidateNames([
            isThisReceiver && state.classStack.length > 0
              ? `${state.classStack[state.classStack.length - 1]}.${propertyName}`
              : undefined,
            receiverType ? `${receiverType}.${propertyName}` : undefined,
            imported?.importedName && imported.importedName !== "*" ? `${imported.importedName}.${propertyName}` : undefined,
            receiverText ? `${receiverText}.${propertyName}` : undefined,
            propertyName,
          ]),
          kind: "call",
          line,
          ownerSymbol: state.currentSymbol,
          rawName: receiverText ? `${receiverText}.${propertyName}` : propertyName,
        });
      }
    }

    ts.forEachChild(node, (child) => visit(child, state));
  };

  visit(sourceFile, {
    classStack: [],
    currentSymbol: undefined,
    variableTypes: new Map<string, string>(),
  });

  return {
    imports,
    symbols: [...symbols.values()].sort((left, right) => left.line - right.line || left.fullName.localeCompare(right.fullName)),
    usages,
  };
}

export const javascriptAdapter: LanguageAdapter = {
  analyzeSource(fileId, relativePath, content) {
    return analyzeSourceWithAst(fileId, relativePath, content);
  },
  extractSymbols(fileId, content) {
    return analyzeSourceWithAst(fileId, "source.ts", content).symbols;
  },
  language: "javascript",
  projectMarkerPatterns: [/^package\.json$/i, /^tsconfig\.json$/i],
  sourceExtensions: [".js", ".jsx", ".ts", ".tsx"],
};
