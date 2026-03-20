import { createHash } from "node:crypto";

import type { CollectedFile, IndexedFileRecord } from "../common/types.js";

export function computeSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function buildStableId(parts: string[]): string {
  return createHash("sha1").update(parts.join("::")).digest("hex");
}

export function hasFileChanged(existing: IndexedFileRecord | undefined, file: CollectedFile): boolean {
  if (!existing) {
    return true;
  }

  return existing.mtimeMs !== file.mtimeMs || existing.size !== file.size;
}
