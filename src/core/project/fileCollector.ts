import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { inferLanguageFromFilePath } from "../../adapters/index.js";
import type { CollectedFile, Settings } from "../common/types.js";
import { IgnoreManager } from "./ignoreManager.js";
import { toProjectRelativePath } from "./pathNormalizer.js";

export async function collectSourceFiles(
  projectRootPath: string,
  settings: Settings,
  ignoreManager: IgnoreManager,
): Promise<CollectedFile[]> {
  const results: CollectedFile[] = [];
  const allowedExtensions = new Set(settings.textExtensions.map((extension) => extension.toLowerCase()));
  const maxFileSizeBytes = settings.maxFileSizeKb * 1024;

  async function walk(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      const relativePath = toProjectRelativePath(projectRootPath, absolutePath);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (ignoreManager.shouldIgnore(relativePath, true)) {
          continue;
        }

        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (ignoreManager.shouldIgnore(relativePath, false)) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(extension)) {
        continue;
      }

      const language = inferLanguageFromFilePath(relativePath);
      if (language === "unknown") {
        continue;
      }

      const stats = await stat(absolutePath);
      if (stats.size > maxFileSizeBytes) {
        continue;
      }

      results.push({
        absolutePath,
        language,
        mtimeMs: Math.round(stats.mtimeMs),
        relativePath,
        size: stats.size,
      });
    }
  }

  await walk(projectRootPath);
  results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return results;
}
