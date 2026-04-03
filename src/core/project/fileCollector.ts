import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { inferLanguageFromFilePath } from "../../adapters/index.js";
import { mapInBatches } from "../common/batch.js";
import type { CollectedFile, Settings } from "../common/types.js";
import { IgnoreManager } from "./ignoreManager.js";
import { toProjectRelativePath } from "./pathNormalizer.js";

export async function collectSourceFiles(
  projectRootPath: string,
  settings: Settings,
  ignoreManager: IgnoreManager,
): Promise<CollectedFile[]> {
  const allowedExtensions = new Set(settings.textExtensions.map((extension) => extension.toLowerCase()));
  const maxFileSizeBytes = settings.maxFileSizeKb * 1024;

  async function walk(currentDirectory: string): Promise<CollectedFile[]> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    const nestedDirectories: string[] = [];
    const fileCandidates: Array<{
      absolutePath: string;
      language: CollectedFile["language"];
      relativePath: string;
    }> = [];

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

        nestedDirectories.push(absolutePath);
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

      fileCandidates.push({
        absolutePath,
        language,
        relativePath,
      });
    }

    const nestedResults = await mapInBatches(nestedDirectories, settings.batchSize, (directoryPath) => walk(directoryPath));
    const currentResults = await mapInBatches(fileCandidates, settings.batchSize, async (candidate) => {
      const stats = await stat(candidate.absolutePath);
      if (stats.size > maxFileSizeBytes) {
        return undefined;
      }

      return {
        absolutePath: candidate.absolutePath,
        language: candidate.language,
        mtimeMs: Math.round(stats.mtimeMs),
        relativePath: candidate.relativePath,
        size: stats.size,
      } satisfies CollectedFile;
    });

    return [
      ...nestedResults.flat(),
      ...currentResults.filter((result): result is CollectedFile => result !== undefined),
    ];
  }

  const results = await walk(projectRootPath);
  results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return results;
}
