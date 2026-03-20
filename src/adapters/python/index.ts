import type { LanguageAdapter } from "../../core/common/types.js";
import { extractSymbolsWithPatterns } from "../helpers.js";

export const pythonAdapter: LanguageAdapter = {
  extractSymbols(fileId, content) {
    return extractSymbolsWithPatterns(fileId, "python", content, [
      { kind: "class", pattern: /^\s*class\s+([A-Za-z_]\w*)/gm },
      { kind: "function", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm },
    ]);
  },
  language: "python",
  projectMarkerPatterns: [/^pyproject\.toml$/i, /^requirements\.txt$/i, /^setup\.py$/i],
  sourceExtensions: [".py"],
};
