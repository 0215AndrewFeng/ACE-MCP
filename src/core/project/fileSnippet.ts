import { readFile } from "node:fs/promises";

import { normalizeAbsolutePath, resolveProjectPath, toProjectRelativePath } from "./pathNormalizer.js";

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
  const normalizedProjectRootPath = normalizeAbsolutePath(projectRootPath);
  const absolutePath = resolveProjectPath(normalizedProjectRootPath, filePath);
  const content = await readFile(absolutePath, "utf8");
  const lines = content.split(/\r?\n/);
  const lineCount = lines.length;
  const normalizedStart = Math.min(startLine, endLine);
  const normalizedEnd = Math.max(startLine, endLine);
  const safeStart = Math.min(Math.max(normalizedStart, 1), lineCount);
  const safeEnd = Math.min(Math.max(normalizedEnd, safeStart), lineCount);

  return {
    endLine: safeEnd,
    filePath: toProjectRelativePath(normalizedProjectRootPath, absolutePath),
    projectRootPath: normalizedProjectRootPath,
    snippet: lines.slice(safeStart - 1, safeEnd).join("\n"),
    startLine: safeStart,
  };
}
