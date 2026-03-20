import type { LanguageAdapter } from "../../core/common/types.js";
import { extractSymbolsWithPatterns } from "../helpers.js";

export const dotnetAdapter: LanguageAdapter = {
  extractSymbols(fileId, content) {
    return extractSymbolsWithPatterns(fileId, "dotnet", content, [
      { kind: "record", pattern: /^\s*(?:public|internal)?\s*record\s+([A-Za-z_]\w*)/gm },
      { kind: "class", pattern: /^\s*(?:public|internal)?\s*class\s+([A-Za-z_]\w*)/gm },
      { kind: "interface", pattern: /^\s*(?:public|internal)?\s*interface\s+([A-Za-z_]\w*)/gm },
      {
        kind: "method",
        pattern:
          /^\s*(?:public|private|protected|internal|static|virtual|override|async|\s)+[\w<>\[\],?]+\s+([A-Za-z_]\w*)\s*\(/gm,
      },
    ]);
  },
  language: "dotnet",
  projectMarkerPatterns: [/\.sln$/i, /\.csproj$/i],
  sourceExtensions: [".cs"],
};
