import { readdir } from "node:fs/promises";
import path from "node:path";

import { detectLanguagesFromRootEntries } from "../../adapters/index.js";
import type { CollectedFile, Language, ProjectInfo } from "../common/types.js";

export async function detectProject(rootPath: string, files: CollectedFile[]): Promise<ProjectInfo> {
  const rootEntries = await readdir(rootPath, { withFileTypes: true });
  const markers = rootEntries.map((entry) => entry.name);
  const detected = detectLanguagesFromRootEntries(markers);
  const detectedLanguages = new Set<Language>(detected.languages);

  for (const file of files) {
    if (file.language !== "unknown") {
      detectedLanguages.add(file.language);
    }
  }

  const languages = [...detectedLanguages].sort();

  return {
    languages,
    markers: detected.matchedMarkers,
    projectType: languages.length > 1 ? "mixed" : "single-language",
    rootPath: path.resolve(rootPath),
  };
}
