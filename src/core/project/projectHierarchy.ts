import { normalizeAbsolutePath } from "./pathNormalizer.js";

export function isNestedProjectPath(parentPath: string, candidatePath: string): boolean {
  const parent = normalizeAbsolutePath(parentPath);
  const candidate = normalizeAbsolutePath(candidatePath);
  return candidate !== parent && candidate.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

export function findNestedProjectPaths(parentPath: string, projectRootPaths: string[]): string[] {
  return projectRootPaths.filter((candidatePath) => isNestedProjectPath(parentPath, candidatePath));
}

export function findAggregateProjectRoots(projectRootPaths: string[]): Set<string> {
  const normalizedRoots = [...new Set(projectRootPaths.map(normalizeAbsolutePath))];
  return new Set(
    normalizedRoots.filter((root) => findNestedProjectPaths(root, normalizedRoots).length > 1),
  );
}
