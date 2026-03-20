import { readFile, stat } from "node:fs/promises";

import iconv from "iconv-lite";

import type { Logger } from "../common/logger.js";
import type {
  CollectedFile,
  IndexProjectResult,
  IndexedFileRecord,
  ProjectInfo,
  Settings,
} from "../common/types.js";
import { buildChunks } from "./chunker.js";
import { buildStableId, computeSha256, hasFileChanged } from "./fileFingerprint.js";
import { extractSymbols } from "./symbolExtractor.js";
import { AppError } from "../common/errors.js";
import { collectSourceFiles } from "../project/fileCollector.js";
import { IgnoreManager } from "../project/ignoreManager.js";
import { normalizeAbsolutePath } from "../project/pathNormalizer.js";
import { detectProject } from "../project/projectDetector.js";
import { SQLiteStore } from "../storage/sqliteStore.js";

interface DecodedSource {
  content: string;
  encoding: string;
}

function scoreDecodedContent(content: string): number {
  const replacementCount = (content.match(/\uFFFD/g) ?? []).length;
  const printableCount = [...content].filter((character) => character === "\n" || character === "\r" || character === "\t" || character >= " ").length;
  return printableCount - replacementCount * 10;
}

function decodeSourceBuffer(buffer: Buffer): DecodedSource {
  const encodings = ["utf8", "utf16le", "gbk", "latin1"] as const;
  let best: DecodedSource = { content: buffer.toString("utf8"), encoding: "utf8" };
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const encoding of encodings) {
    try {
      const content = iconv.decode(buffer, encoding);
      const score = scoreDecodedContent(content);
      if (score > bestScore) {
        best = { content, encoding };
        bestScore = score;
      }
    } catch {
      continue;
    }
  }

  return best;
}

export class IndexCoordinator {
  public constructor(
    private readonly settings: Settings,
    private readonly store: SQLiteStore,
    private readonly logger: Logger,
  ) {}

  public async indexProject(projectRootPath: string, mode: "full" | "incremental" = "incremental"): Promise<IndexProjectResult> {
    const normalizedRoot = normalizeAbsolutePath(projectRootPath);
    const rootStats = await stat(normalizedRoot).catch(() => null);
    if (!rootStats?.isDirectory()) {
      throw new AppError("INVALID_PROJECT_ROOT", `Project root does not exist or is not a directory: ${normalizedRoot}`);
    }

    const ignoreManager = await IgnoreManager.create(normalizedRoot, this.settings.excludePatterns);
    const sourceFiles = await collectSourceFiles(normalizedRoot, this.settings, ignoreManager);
    const project = await detectProject(normalizedRoot, sourceFiles);
    const projectId = buildStableId([normalizedRoot]);
    const timestamp = new Date().toISOString();

    this.store.upsertProject(projectId, project, "indexing", timestamp);

    const existingFiles = new Map(
      this.store.listProjectFiles(projectId).map((file) => [file.relativePath, file]),
    );
    const currentPaths = new Set(sourceFiles.map((file) => file.relativePath));
    const deletedFiles = [...existingFiles.keys()].filter((relativePath) => !currentPaths.has(relativePath));
    this.store.deleteFiles(projectId, deletedFiles);

    let changedFiles = 0;
    let chunkCount = 0;
    let indexedFiles = 0;

    for (const file of sourceFiles) {
      const existing = existingFiles.get(file.relativePath);
      if (mode !== "full" && !hasFileChanged(existing, file)) {
        continue;
      }

      changedFiles += 1;
      const buffer = await readFile(file.absolutePath);
      const { content, encoding } = decodeSourceBuffer(buffer);
      const fileId = buildStableId([projectId, file.relativePath]);
      const symbols = extractSymbols(fileId, file.language, content);
      const chunks = buildChunks(fileId, file.relativePath, content, symbols, this.settings.maxLinesPerChunk);
      const indexedFile: IndexedFileRecord = {
        encoding,
        fileId,
        language: file.language,
        lineCount: content.split(/\r?\n/).length,
        mtimeMs: file.mtimeMs,
        relativePath: file.relativePath,
        sha256: computeSha256(buffer),
        size: file.size,
      };

      this.store.writeFileIndex(projectId, indexedFile, chunks, symbols, timestamp);
      indexedFiles += 1;
      chunkCount += chunks.length;
    }

    this.store.updateProjectAfterIndex(projectId, timestamp, "ready");
    this.store.recordIndexEvent(projectId, {
      changedFiles,
      chunkCount,
      createdAt: timestamp,
      deletedFiles: deletedFiles.length,
      indexedFiles,
      scannedFiles: sourceFiles.length,
    });

    this.logger.info("project indexed", {
      changedFiles,
      chunkCount,
      deletedFiles: deletedFiles.length,
      indexedFiles,
      projectRootPath: normalizedRoot,
      scannedFiles: sourceFiles.length,
    });

    return {
      changedFiles,
      chunkCount,
      deletedFiles: deletedFiles.length,
      indexedFiles,
      project,
      projectId,
      projectRootPath: normalizedRoot,
      scannedFiles: sourceFiles.length,
    };
  }
}
