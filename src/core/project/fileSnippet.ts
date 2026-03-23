import { readFile } from "node:fs/promises";

import { resolveProjectPath } from "./pathNormalizer.js";

export interface FileSnippetResult {
  endLine: number;
  filePath: string;
  projectRootPath: string;
  snippet: string;
  startLine: number;
}

export async function readFileSnippet(
  projectRootPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<FileSnippetResult> {
  const absolutePath = resolveProjectPath(projectRootPath, filePath);
  const content = await readFile(absolutePath, "utf8");
  const lines = content.split(/\r?\n/);
  const lineCount = lines.length;
  const normalizedStart = Math.min(startLine, endLine);
  const normalizedEnd = Math.max(startLine, endLine);
  const safeStart = Math.min(Math.max(normalizedStart, 1), lineCount);
  const safeEnd = Math.min(Math.max(normalizedEnd, safeStart), lineCount);

  return {
    endLine: safeEnd,
    filePath,
    projectRootPath,
    snippet: lines.slice(safeStart - 1, safeEnd).join("\n"),
    startLine: safeStart,
  };
}
