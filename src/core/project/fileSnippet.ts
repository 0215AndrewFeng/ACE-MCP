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
  const safeStart = Math.min(startLine, endLine);
  const safeEnd = Math.max(startLine, endLine);

  return {
    endLine: safeEnd,
    filePath,
    projectRootPath,
    snippet: lines.slice(safeStart - 1, safeEnd).join("\n"),
    startLine: safeStart,
  };
}
