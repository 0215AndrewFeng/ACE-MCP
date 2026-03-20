import type { LanguageAdapter } from "../../core/common/types.js";
import { extractSymbolsWithPatterns } from "../helpers.js";

export const javaAdapter: LanguageAdapter = {
  extractSymbols(fileId, content) {
    return extractSymbolsWithPatterns(fileId, "java", content, [
      { kind: "class", pattern: /^\s*(?:public|private|protected)?\s*class\s+([A-Za-z_]\w*)/gm },
      { kind: "interface", pattern: /^\s*(?:public|private|protected)?\s*interface\s+([A-Za-z_]\w*)/gm },
      { kind: "enum", pattern: /^\s*(?:public|private|protected)?\s*enum\s+([A-Za-z_]\w*)/gm },
      {
        kind: "method",
        pattern:
          /^\s*(?:public|private|protected|static|final|abstract|synchronized|\s)+[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/gm,
      },
    ]);
  },
  language: "java",
  projectMarkerPatterns: [/^pom\.xml$/i, /^build\.gradle$/i, /^settings\.gradle$/i],
  sourceExtensions: [".java"],
};
