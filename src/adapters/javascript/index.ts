import path from "node:path";

import ts from "typescript";

import { JS_EXPORTED_VALUE_TYPE_CANDIDATE_PREFIX } from "../../core/common/types.js";
import type { ImportInfo, LanguageAdapter, SourceAnalysis, SymbolInfo, SymbolUsageInfo } from "../../core/common/types.js";
import { buildStableId } from "../../core/indexing/fileFingerprint.js";
import { buildModulePath, normalizeSignature } from "../helpers.js";

function buildFullName(containers: string[], name: string): string {
  return containers.length > 0 ? `${containers.join(".")}.${name}` : name;
}

function buildCanonicalName(modulePath: string, fullName: string): string {
  return modulePath.length > 0 ? `${modulePath}#${fullName}` : fullName;
}

function isSingleFileComponentPath(relativePath: string): boolean {
  return /\.(?:vue|svelte)$/i.test(relativePath);
}

interface SourceRange {
  end: number;
  start: number;
}

const HTML_TAG_NAMES = new Set([
  "a",
  "article",
  "aside",
  "audio",
  "button",
  "canvas",
  "code",
  "div",
  "em",
  "fieldset",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "iframe",
  "img",
  "input",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "select",
  "small",
  "span",
  "strong",
  "svg",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "video",
]);

const TEMPLATE_IDENTIFIER_STOP_WORDS = new Set([
  "Array",
  "Boolean",
  "Date",
  "JSON",
  "Math",
  "Number",
  "Object",
  "Promise",
  "String",
  "console",
  "document",
  "else",
  "event",
  "false",
  "for",
  "function",
  "if",
  "in",
  "let",
  "null",
  "return",
  "this",
  "true",
  "undefined",
  "window",
]);

function collectScriptRanges(content: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const scriptPattern = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;

  for (const match of content.matchAll(scriptPattern)) {
    const fullMatch = match[0];
    const matchStart = match.index ?? 0;
    const openTag = fullMatch.match(/^<script\b[^>]*>/i)?.[0];
    const closeTag = fullMatch.match(/<\/script\s*>$/i)?.[0];
    if (!openTag || !closeTag) {
      continue;
    }

    ranges.push({
      end: matchStart + fullMatch.length - closeTag.length,
      start: matchStart + openTag.length,
    });
  }

  return ranges;
}

function extractScriptOnlyContent(content: string): string {
  const output: string[] = content.split("").map((character) => (character === "\n" || character === "\r" ? character : " "));

  for (const range of collectScriptRanges(content)) {
    for (let index = range.start; index < range.end; index += 1) {
      output[index] = content[index] ?? " ";
    }
  }

  return output.join("");
}

function collectVueTemplateRanges(content: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const templatePattern = /<template\b[^>]*>[\s\S]*?<\/template\s*>/gi;

  for (const match of content.matchAll(templatePattern)) {
    const fullMatch = match[0];
    const matchStart = match.index ?? 0;
    const openTag = fullMatch.match(/^<template\b[^>]*>/i)?.[0];
    const closeTag = fullMatch.match(/<\/template\s*>$/i)?.[0];
    if (!openTag || !closeTag) {
      continue;
    }

    ranges.push({
      end: matchStart + fullMatch.length - closeTag.length,
      start: matchStart + openTag.length,
    });
  }

  return ranges;
}

function collectSvelteMarkupRanges(content: string): SourceRange[] {
  const scriptRanges = collectScriptRanges(content).sort((left, right) => left.start - right.start);
  const ranges: SourceRange[] = [];
  let cursor = 0;

  for (const scriptRange of scriptRanges) {
    const scriptOpenStart = content.lastIndexOf("<script", scriptRange.start);
    const fullScriptStart = scriptOpenStart >= 0 ? scriptOpenStart : scriptRange.start;
    const closeEnd = content.indexOf(">", scriptRange.end);
    const fullScriptEnd = closeEnd >= 0 ? closeEnd + 1 : scriptRange.end;
    if (cursor < fullScriptStart) {
      ranges.push({ start: cursor, end: fullScriptStart });
    }
    cursor = Math.max(cursor, fullScriptEnd);
  }

  if (cursor < content.length) {
    ranges.push({ start: cursor, end: content.length });
  }

  return ranges;
}

function getLineNumberAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === "\n") {
      line += 1;
    }
  }
  return line;
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
  vueOptionsComponentName?: string;
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

function toPascalCase(value: string): string {
  return value
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function buildTemplateCandidateNames(rawName: string): string[] {
  const leafName = rawName.split(".").pop() ?? rawName;
  const candidates = [rawName, leafName];
  if (/[-_:]/.test(rawName)) {
    candidates.push(toPascalCase(rawName));
  }
  if (/[-_:]/.test(leafName)) {
    candidates.push(toPascalCase(leafName));
  }
  return dedupeCandidateNames(candidates);
}

function buildComponentTagCandidateNames(tagName: string): string[] {
  const candidates = buildTemplateCandidateNames(tagName);
  if (/^[a-z][a-z0-9]*$/.test(tagName)) {
    candidates.push(tagName.charAt(0).toUpperCase() + tagName.slice(1));
  }
  return dedupeCandidateNames(candidates);
}

function isComponentLikeTag(tagName: string): boolean {
  if (tagName.startsWith("svelte:")) {
    return false;
  }

  const normalized = tagName.toLowerCase();
  if (HTML_TAG_NAMES.has(normalized)) {
    return false;
  }

  return true;
}

function pushTemplateUsage(
  usages: SymbolUsageInfo[],
  seen: Set<string>,
  rawName: string,
  line: number,
  candidateNames = buildTemplateCandidateNames(rawName),
): void {
  const normalizedRawName = rawName.trim();
  if (!normalizedRawName) {
    return;
  }

  const rootName = normalizedRawName.split(".")[0];
  if (!rootName || TEMPLATE_IDENTIFIER_STOP_WORDS.has(rootName)) {
    return;
  }

  const key = `${line}:${normalizedRawName}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);

  pushUsage(usages, {
    candidateNames,
    kind: "usage",
    line,
    rawName: normalizedRawName,
  });
}

function stripTemplateExpressionNoise(expression: string): string {
  return expression
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, " ")
    .replace(/^[:#/]\s*/, " ")
    .replace(/^(if|each|await|key|then|catch|else)\b/, " ");
}

function extractTemplateExpressionUsages(
  expression: string,
  lineNumber: number,
  usages: SymbolUsageInfo[],
  seen: Set<string>,
): void {
  const expressionWithoutStrings = stripTemplateExpressionNoise(expression);
  const identifierPattern = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/g;

  for (const match of expressionWithoutStrings.matchAll(identifierPattern)) {
    pushTemplateUsage(usages, seen, match[0], lineNumber);
  }
}

function extractTemplateLineUsages(
  line: string,
  lineNumber: number,
  mode: "svelte" | "vue",
  usages: SymbolUsageInfo[],
  seen: Set<string>,
): void {
  const tagPattern = /<\/?([A-Za-z][A-Za-z0-9_.:-]*)\b/g;
  for (const match of line.matchAll(tagPattern)) {
    if (match[0].startsWith("</")) {
      continue;
    }

    const tagName = match[1];
    if (tagName && isComponentLikeTag(tagName)) {
      pushTemplateUsage(usages, seen, tagName, lineNumber, buildComponentTagCandidateNames(tagName));
    }
  }

  if (mode === "vue") {
    const moustachePattern = /{{([\s\S]*?)}}/g;
    for (const match of line.matchAll(moustachePattern)) {
      extractTemplateExpressionUsages(match[1] ?? "", lineNumber, usages, seen);
    }

    const directivePattern = /\s([:@#][\w:.-]+|v-[\w:.-]+)\s*=\s*(["'])(.*?)\2/g;
    for (const match of line.matchAll(directivePattern)) {
      extractTemplateExpressionUsages(match[3] ?? "", lineNumber, usages, seen);
    }
    return;
  }

  const svelteExpressionPattern = /{([^{}]+)}/g;
  for (const match of line.matchAll(svelteExpressionPattern)) {
    extractTemplateExpressionUsages(match[1] ?? "", lineNumber, usages, seen);
  }
}

function extractTemplateUsages(relativePath: string, content: string): SymbolUsageInfo[] {
  const isVue = /\.vue$/i.test(relativePath);
  const isSvelte = /\.svelte$/i.test(relativePath);
  if (!isVue && !isSvelte) {
    return [];
  }

  const usages: SymbolUsageInfo[] = [];
  const seen = new Set<string>();
  const ranges = isVue ? collectVueTemplateRanges(content) : collectSvelteMarkupRanges(content);

  for (const range of ranges) {
    const rangeContent = content.slice(range.start, range.end);
    const baseLine = getLineNumberAtOffset(content, range.start);
    const lines = rangeContent.split(/\r\n|\r|\n/);
    for (const [index, line] of lines.entries()) {
      extractTemplateLineUsages(line, baseLine + index, isVue ? "vue" : "svelte", usages, seen);
    }
  }

  return usages;
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

function isExportedVariableDeclaration(node: ts.VariableDeclaration): boolean {
  const statement = node.parent.parent;
  if (!ts.isVariableStatement(statement)) {
    return false;
  }

  return ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

const VUE_OPTIONS_MEMBER_GROUPS = new Set(["computed", "methods", "watch"]);
const VUE_OPTIONS_LIFECYCLE_HOOKS = new Set([
  "beforeCreate",
  "created",
  "beforeMount",
  "mounted",
  "beforeUpdate",
  "updated",
  "activated",
  "deactivated",
  "beforeUnmount",
  "unmounted",
  "beforeDestroy",
  "destroyed",
  "errorCaptured",
]);

function getObjectLiteralProperty(sourceFile: ts.SourceFile, objectLiteral: ts.ObjectLiteralExpression, propertyName: string): ts.Expression | undefined {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const name = getDeclarationName(sourceFile, property.name);
    if (name === propertyName) {
      return property.initializer;
    }
  }

  return undefined;
}

function getVueOptionsComponentName(sourceFile: ts.SourceFile, objectLiteral: ts.ObjectLiteralExpression, relativePath: string): string {
  const nameExpression = getObjectLiteralProperty(sourceFile, objectLiteral, "name");
  if (nameExpression && ts.isStringLiteralLike(nameExpression) && nameExpression.text.trim().length > 0) {
    return nameExpression.text.trim();
  }

  return path.posix.basename(relativePath.replace(/\\/g, "/")).replace(/\.[^.]+$/, "");
}

function isFunctionLikeExpression(expression: ts.Expression): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

function isVueOptionsExportDefaultObject(node: ts.Node): node is ts.ExportAssignment & { expression: ts.ObjectLiteralExpression } {
  return ts.isExportAssignment(node) && !node.isExportEquals && ts.isObjectLiteralExpression(node.expression);
}

function getReturnedObjectLiteral(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  let returnedObject: ts.ObjectLiteralExpression | undefined;

  const visitReturn = (child: ts.Node): void => {
    if (returnedObject) {
      return;
    }

    if (ts.isReturnStatement(child) && child.expression && ts.isObjectLiteralExpression(child.expression)) {
      returnedObject = child.expression;
      return;
    }

    ts.forEachChild(child, visitReturn);
  };

  ts.forEachChild(node, visitReturn);
  return returnedObject;
}

function getObjectLiteralPropertyNames(sourceFile: ts.SourceFile, objectLiteral: ts.ObjectLiteralExpression): Array<{ name: string; node: ts.Node }> {
  const properties: Array<{ name: string; node: ts.Node }> = [];

  for (const property of objectLiteral.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const name = getDeclarationName(sourceFile, property.name);
      if (name) {
        properties.push({ name, node: property });
      }
    }
  }

  return properties;
}

function getArrayStringLiteralNames(arrayLiteral: ts.ArrayLiteralExpression): Array<{ name: string; node: ts.Node }> {
  const properties: Array<{ name: string; node: ts.Node }> = [];

  for (const element of arrayLiteral.elements) {
    if (ts.isStringLiteralLike(element) && element.text.trim().length > 0) {
      properties.push({ name: element.text.trim(), node: element });
    }
  }

  return properties;
}

function analyzeSourceWithAst(fileId: string, relativePath: string, content: string): SourceAnalysis {
  const sourceContent = isSingleFileComponentPath(relativePath) ? extractScriptOnlyContent(content) : content;
  const isVueSingleFileComponent = /\.vue$/i.test(relativePath);
  const scriptKind = relativePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : relativePath.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : relativePath.endsWith(".js") || relativePath.endsWith(".mjs") || relativePath.endsWith(".cjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(relativePath, sourceContent, ts.ScriptTarget.Latest, true, scriptKind);
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
    if (isVueSingleFileComponent && isVueOptionsExportDefaultObject(node)) {
      const componentName = getVueOptionsComponentName(sourceFile, node.expression, relativePath);
      for (const property of node.expression.properties) {
        visit(property, {
          classStack: [componentName],
          currentSymbol: state.currentSymbol,
          variableTypes: new Map(state.variableTypes),
          vueOptionsComponentName: componentName,
        });
      }
      return;
    }

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
      if (methodName === "data" && state.vueOptionsComponentName && ts.isMethodDeclaration(node)) {
        const returnedObject = getReturnedObjectLiteral(node);
        if (returnedObject) {
          for (const property of getObjectLiteralPropertyNames(sourceFile, returnedObject)) {
            addSymbol("property", property.name, [state.vueOptionsComponentName], property.node);
          }
        }
        return;
      }

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
          if (isExportedVariableDeclaration(node)) {
            pushUsage(usages, {
              candidateNames: [`${JS_EXPORTED_VALUE_TYPE_CANDIDATE_PREFIX}${typeName}`, typeName],
              kind: "usage",
              line: getLineNumber(sourceFile, node.initializer),
              ownerSymbol: state.currentSymbol,
              rawName: variableName,
            });
          }
        }
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const propertyName = getDeclarationName(sourceFile, node.name);
      if (propertyName && state.classStack.length > 0) {
        if (state.vueOptionsComponentName && propertyName === "props") {
          if (ts.isObjectLiteralExpression(node.initializer)) {
            for (const property of getObjectLiteralPropertyNames(sourceFile, node.initializer)) {
              addSymbol("property", property.name, [state.vueOptionsComponentName], property.node);
            }
          } else if (ts.isArrayLiteralExpression(node.initializer)) {
            for (const property of getArrayStringLiteralNames(node.initializer)) {
              addSymbol("property", property.name, [state.vueOptionsComponentName], property.node);
            }
          }
          return;
        }

        if (state.vueOptionsComponentName && propertyName === "data" && isFunctionLikeExpression(node.initializer)) {
          const returnedObject = getReturnedObjectLiteral(node.initializer);
          if (returnedObject) {
            for (const property of getObjectLiteralPropertyNames(sourceFile, returnedObject)) {
              addSymbol("property", property.name, [state.vueOptionsComponentName], property.node);
            }
          }
          return;
        }

        if (state.vueOptionsComponentName && VUE_OPTIONS_MEMBER_GROUPS.has(propertyName) && ts.isObjectLiteralExpression(node.initializer)) {
          for (const member of node.initializer.properties) {
            visit(member, {
              ...state,
              classStack: [state.vueOptionsComponentName],
              variableTypes: new Map(state.variableTypes),
            });
          }
          return;
        }

        if (state.vueOptionsComponentName && VUE_OPTIONS_LIFECYCLE_HOOKS.has(propertyName) && isFunctionLikeExpression(node.initializer)) {
          const fullName = addSymbol("method", propertyName, [state.vueOptionsComponentName], node);
          const nextState: VisitState = {
            classStack: [state.vueOptionsComponentName],
            currentSymbol: fullName,
            variableTypes: new Map(state.variableTypes),
            vueOptionsComponentName: state.vueOptionsComponentName,
          };
          ts.forEachChild(node.initializer, (child) => visit(child, nextState));
          return;
        }

        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
          const fullName = addSymbol("method", propertyName, state.classStack, node);
          const nextState: VisitState = {
            classStack: state.classStack,
            currentSymbol: fullName,
            variableTypes: new Map(state.variableTypes),
            vueOptionsComponentName: state.vueOptionsComponentName,
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
    vueOptionsComponentName: undefined,
    variableTypes: new Map<string, string>(),
  });

  return {
    imports,
    symbols: [...symbols.values()].sort((left, right) => left.line - right.line || left.fullName.localeCompare(right.fullName)),
    usages: isSingleFileComponentPath(relativePath) ? [...usages, ...extractTemplateUsages(relativePath, content)] : usages,
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
  sourceExtensions: [".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte"],
};
