import path from "node:path";

import { AppError } from "../common/errors.js";

export function normalizeAbsolutePath(inputPath: string): string {
  return path.resolve(inputPath).replaceAll(path.sep, "/");
}

export function toProjectRelativePath(projectRootPath: string, absolutePath: string): string {
  return path.relative(path.resolve(projectRootPath), path.resolve(absolutePath)).replaceAll(path.sep, "/");
}

function isPathInsideProjectRoot(projectRootPath: string, candidatePath: string): boolean {
  return candidatePath === projectRootPath || candidatePath.startsWith(`${projectRootPath}/`);
}

export function resolveProjectPath(projectRootPath: string, relativePath: string): string {
  const normalizedProjectRootPath = normalizeAbsolutePath(projectRootPath);
  const resolvedPath = normalizeAbsolutePath(path.resolve(projectRootPath, relativePath));
  if (!isPathInsideProjectRoot(normalizedProjectRootPath, resolvedPath)) {
    throw new AppError("INVALID_PROJECT_PATH", `File path resolves outside the project root: ${relativePath}`);
  }

  return resolvedPath;
}
