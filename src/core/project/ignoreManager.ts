import { readFile } from "node:fs/promises";
import path from "node:path";

import ignore from "ignore";

export class IgnoreManager {
  private constructor(private readonly matcher: ReturnType<typeof ignore>) {}

  public static async create(projectRootPath: string, excludePatterns: string[]): Promise<IgnoreManager> {
    const matcher = ignore().add(excludePatterns);
    try {
      const gitignorePath = path.join(projectRootPath, ".gitignore");
      const content = await readFile(gitignorePath, "utf8");
      matcher.add(content);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    return new IgnoreManager(matcher);
  }

  public shouldIgnore(relativePath: string, isDirectory: boolean): boolean {
    const normalized = relativePath.replaceAll(path.sep, "/");
    const candidate = isDirectory ? `${normalized}/` : normalized;
    return this.matcher.ignores(candidate);
  }
}
