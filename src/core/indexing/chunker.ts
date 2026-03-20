import { buildStableId } from "./fileFingerprint.js";
import type { ChunkRecord, SymbolInfo } from "../common/types.js";

function pickChunkEnd(
  lines: string[],
  startIndex: number,
  desiredEndExclusive: number,
  symbolStartIndexes: number[],
): number {
  const hardEnd = Math.min(lines.length, desiredEndExclusive);
  const minBoundarySize = Math.max(20, Math.floor((hardEnd - startIndex) * 0.55));
  const symbolBoundary = [...symbolStartIndexes]
    .reverse()
    .find((symbolStartIndex) => symbolStartIndex > startIndex + minBoundarySize && symbolStartIndex < hardEnd);

  if (symbolBoundary !== undefined) {
    return symbolBoundary;
  }

  for (let index = hardEnd; index > startIndex + 1 && index > hardEnd - 25; index -= 1) {
    if (lines[index - 1]?.trim() === "") {
      return index;
    }
  }

  return hardEnd;
}

export function buildChunks(
  fileId: string,
  relativePath: string,
  content: string,
  symbols: SymbolInfo[],
  maxLinesPerChunk: number,
): ChunkRecord[] {
  const lines = content.split(/\r?\n/);
  const chunks: ChunkRecord[] = [];
  const symbolStartIndexes = [...new Set(symbols.map((symbol) => Math.max(0, symbol.line - 1)))].sort((left, right) => left - right);

  for (let startIndex = 0; startIndex < lines.length; ) {
    const endExclusive = pickChunkEnd(lines, startIndex, startIndex + maxLinesPerChunk, symbolStartIndexes);
    const startLine = startIndex + 1;
    const endLine = Math.max(startLine, endExclusive);
    const chunkSymbols = symbols
      .filter((symbol) => symbol.line >= startLine && symbol.line <= endLine)
      .map((symbol) => symbol.name);

    chunks.push({
      chunkId: buildStableId([fileId, relativePath, String(startLine), String(endLine)]),
      content: lines.slice(startIndex, endExclusive).join("\n").trim(),
      endLine,
      fileId,
      startLine,
      symbolNames: [...new Set(chunkSymbols)],
    });

    startIndex = Math.max(endExclusive, startIndex + 1);
  }

  return chunks.filter((chunk) => chunk.content.length > 0);
}
