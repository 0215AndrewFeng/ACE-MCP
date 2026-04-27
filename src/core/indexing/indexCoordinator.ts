import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import iconv from "iconv-lite";

import { mapInBatches } from "../common/batch.js";
import type { Logger } from "../common/logger.js";
import type {
  CollectedFile,
  IndexFailure,
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
import { InMemoryEmbeddingProvider } from "../search/embedding.js";

// 共享的嵌入实例
let embeddingProvider: InMemoryEmbeddingProvider | null = null;

function getEmbeddingProvider(): InMemoryEmbeddingProvider {
  if (!embeddingProvider) {
    embeddingProvider = new InMemoryEmbeddingProvider(128, "in-memory-tfidf");
  }
  return embeddingProvider;
}

interface DecodedSource {
  content: string;
  encoding: string;
}

type IndexedFileResult =
  | {
      chunkCount: number;
      indexed: true;
    }
  | {
      filePath: string;
      indexed: false;
      message: string;
    };

function scoreDecodedContent(content: string): number {
  const replacementCount = (content.match(/\uFFFD/g) ?? []).length;
  const printableCount = [...content].filter((character) => character === "\n" || character === "\r" || character === "\t" || character >= " ").length;
  return printableCount - replacementCount * 10;
}

function isValidUtf8(buffer: Buffer): boolean {
  const decoded = buffer.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(buffer);
}

function decodeSourceBuffer(buffer: Buffer): DecodedSource {
  if (isValidUtf8(buffer)) {
    return { content: buffer.toString("utf8"), encoding: "utf8" };
  }

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
    const startedAtMs = performance.now();
    const normalizedRoot = normalizeAbsolutePath(projectRootPath);
    const rootStats = await stat(normalizedRoot).catch(() => null);
    if (!rootStats?.isDirectory()) {
      throw new AppError("INVALID_PROJECT_ROOT", `Project root does not exist or is not a directory: ${normalizedRoot}`);
    }

    const collectStartedAtMs = performance.now();
    const ignoreManager = await IgnoreManager.create(normalizedRoot, this.settings.excludePatterns);
    const sourceFiles = await collectSourceFiles(normalizedRoot, this.settings, ignoreManager);
    const collectMs = Math.round(performance.now() - collectStartedAtMs);
    const detectStartedAtMs = performance.now();
    const project = await detectProject(normalizedRoot, sourceFiles);
    const detectMs = Math.round(performance.now() - detectStartedAtMs);
    const projectId = buildStableId([normalizedRoot]);
    const timestamp = new Date().toISOString();

    this.store.upsertProject(projectId, project, "indexing", timestamp);

    const existingFiles = new Map(
      this.store.listProjectFiles(projectId).map((file) => [file.relativePath, file]),
    );
    const currentPaths = new Set(sourceFiles.map((file) => file.relativePath));
    const deletedFiles = [...existingFiles.keys()].filter((relativePath) => !currentPaths.has(relativePath));
    this.store.deleteFiles(projectId, deletedFiles);

    const filesToIndex = sourceFiles.filter((file) => {
      const existing = existingFiles.get(file.relativePath);
      return mode === "full" || hasFileChanged(existing, file);
    });
    const changedFiles = filesToIndex.length;
    const indexingStartedAtMs = performance.now();
    const fileResults = await mapInBatches<CollectedFile, IndexedFileResult>(filesToIndex, this.settings.batchSize, async (file) => {
      try {
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

        // 生成并存储向量
        const provider = getEmbeddingProvider();
        const chunkTexts = chunks.map((c) => c.content);
        const embeddings = await provider.embedBatch(chunkTexts);
        for (let i = 0; i < chunks.length; i++) {
          this.store.writeChunkVector(chunks[i].chunkId, embeddings[i], provider.getModelName());
        }

        return {
          chunkCount: chunks.length,
          indexed: true as const,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("file indexing failed", {
          error: message,
          filePath: file.relativePath,
          projectRootPath: normalizedRoot,
        });
        return {
          filePath: file.relativePath,
          indexed: false as const,
          message,
        };
      }
    });
    const indexMs = Math.round(performance.now() - indexingStartedAtMs);
    const failedFiles: IndexFailure[] = [];
    let chunkCount = 0;
    let indexedFiles = 0;
    for (const result of fileResults) {
      if (result.indexed) {
        indexedFiles += 1;
        chunkCount += result.chunkCount;
        continue;
      }

      failedFiles.push({
        filePath: result.filePath,
        message: result.message,
      });
    }

    this.store.updateProjectAfterIndex(projectId, timestamp, "ready");
    this.store.recordIndexEvent(projectId, {
      changedFiles,
      chunkCount,
      createdAt: timestamp,
      deletedFiles: deletedFiles.length,
      failedFiles,
      indexedFiles,
      scannedFiles: sourceFiles.length,
    });

    this.logger.info("project indexed", {
      batchSize: this.settings.batchSize,
      changedFiles,
      collectMs,
      chunkCount,
      detectMs,
      deletedFiles: deletedFiles.length,
      failedFileCount: failedFiles.length,
      indexMs,
      indexedFiles,
      projectRootPath: normalizedRoot,
      scannedFiles: sourceFiles.length,
      totalMs: Math.round(performance.now() - startedAtMs),
    });

    return {
      changedFiles,
      chunkCount,
      createdAt: timestamp,
      deletedFiles: deletedFiles.length,
      failedFileCount: failedFiles.length,
      failedFiles,
      indexedFiles,
      project,
      projectId,
      projectRootPath: normalizedRoot,
      scannedFiles: sourceFiles.length,
    };
  }
}
