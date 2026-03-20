import path from "node:path";

export function normalizeAbsolutePath(inputPath: string): string {
  return path.resolve(inputPath).replaceAll(path.sep, "/");
}

export function toProjectRelativePath(projectRootPath: string, absolutePath: string): string {
  return path.relative(projectRootPath, absolutePath).replaceAll(path.sep, "/");
}

export function resolveProjectPath(projectRootPath: string, relativePath: string): string {
  return path.resolve(projectRootPath, relativePath);
}
