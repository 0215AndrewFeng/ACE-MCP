import type { LanguageAdapter } from "../../core/common/types.js";
import { extractSymbolsWithPatterns } from "../helpers.js";

export const javascriptAdapter: LanguageAdapter = {
  extractSymbols(fileId, content) {
    return extractSymbolsWithPatterns(fileId, "javascript", content, [
      { kind: "class", pattern: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
      { kind: "function", pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm },
      {
        kind: "function",
        pattern:
          /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
      },
    ]);
  },
  language: "javascript",
  projectMarkerPatterns: [/^package\.json$/i, /^tsconfig\.json$/i],
  sourceExtensions: [".js", ".jsx", ".ts", ".tsx"],
};
