import { readFile, stat } from "node:fs/promises";

import { normalizeAbsolutePath, resolveProjectPath, toProjectRelativePath } from "./pathNormalizer.js";

export interface FileSnippetResult {
  endLine: number;
  filePath: string;
  projectRootPath: string;
  snippet: string;
  startLine: number;
}

interface CachedFile {
  lines: string[];
  mtimeMs: number;
}

const MAX_CACHE_SIZE = 200;
const cache = new Map<string, CachedFile>();
const cacheOrder: string[] = [];

function evictCache(): void {
  while (cache.size > MAX_CACHE_SIZE && cacheOrder.length > 0) {
    const oldest = cacheOrder.shift()!;
    cache.delete(oldest);
  }
}

export async function readFileSnippet(
  projectRootPath: string,
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<FileSnippetResult> {
  const normalizedProjectRootPath = normalizeAbsolutePath(projectRootPath);
  const absolutePath = resolveProjectPath(normalizedProjectRootPath, filePath);

  // v4.5.4: LRU cache for file lines — avoids re-reading files on repeated snippet requests
  const fileStat = await stat(absolutePath);
  const mtimeMs = fileStat.mtimeMs;
  const cached = cache.get(absolutePath);

  let lines: string[];
  if (cached && cached.mtimeMs === mtimeMs) {
    lines = cached.lines;
    // LRU: move to end
    const idx = cacheOrder.indexOf(absolutePath);
    if (idx >= 0) cacheOrder.splice(idx, 1);
    cacheOrder.push(absolutePath);
  } else {
    const content = await readFile(absolutePath, "utf8");
    lines = content.split(/\r?\n/);
    cache.set(absolutePath, { lines, mtimeMs });
    const idx = cacheOrder.indexOf(absolutePath);
    if (idx >= 0) cacheOrder.splice(idx, 1);
    cacheOrder.push(absolutePath);
    evictCache();
  }

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

/** Clear the file snippet cache (useful for testing or forced refresh) */
export function clearFileSnippetCache(): void {
  cache.clear();
  cacheOrder.length = 0;
}