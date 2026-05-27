/**
 * v4.3.3: Git helper for incremental indexing
 * Uses git diff to detect changed files instead of full filesystem scan.
 */

import { exec } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface GitStatus {
  isGitRepo: boolean;
  currentCommit?: string;
  changedFiles?: string[];
  untrackedFiles?: string[];
}

/**
 * Check if a directory is a git repository
 */
export async function isGitRepository(projectRoot: string): Promise<boolean> {
  try {
    const gitDir = path.join(projectRoot, ".git");
    const stats = await stat(gitDir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Get the current HEAD commit SHA
 */
export async function getHeadCommit(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse HEAD", {
      cwd: projectRoot,
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get list of files changed between two commits
 */
async function getChangedFilesBetweenCommits(
  projectRoot: string,
  fromCommit: string,
  toCommit: string,
): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`git diff --name-only ${fromCommit} ${toCommit}`, {
      cwd: projectRoot,
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
    });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get list of uncommitted changed files (staged and unstaged)
 */
async function getUncommittedChanges(projectRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git diff --name-only HEAD", {
      cwd: projectRoot,
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get list of untracked files (not in .gitignore)
 */
async function getUntrackedFiles(projectRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git ls-files --others --exclude-standard", {
      cwd: projectRoot,
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get the full git status for incremental indexing decisions.
 *
 * If lastIndexedCommit is provided and matches current HEAD:
 *   - Returns only uncommitted changes and untracked files
 *
 * If lastIndexedCommit is provided but differs from HEAD:
 *   - Returns files changed between commits + uncommitted + untracked
 *
 * If not a git repo:
 *   - Returns { isGitRepo: false }, caller should fallback to full scan
 */
export async function getGitChangedFiles(
  projectRoot: string,
  lastIndexedCommit?: string,
): Promise<GitStatus> {
  const isRepo = await isGitRepository(projectRoot);
  if (!isRepo) {
    return { isGitRepo: false };
  }

  const currentCommit = await getHeadCommit(projectRoot);
  if (!currentCommit) {
    return { isGitRepo: false };
  }

  // Always get uncommitted changes and untracked files
  const [uncommitted, untracked] = await Promise.all([
    getUncommittedChanges(projectRoot),
    getUntrackedFiles(projectRoot),
  ]);

  // If no previous index or different commit, get inter-commit diff
  let committedChanges: string[] = [];
  if (lastIndexedCommit && lastIndexedCommit !== currentCommit) {
    committedChanges = await getChangedFilesBetweenCommits(
      projectRoot,
      lastIndexedCommit,
      currentCommit,
    );
  }

  // Merge and deduplicate all changed files
  const allChanges = [...new Set([...committedChanges, ...uncommitted])];

  return {
    isGitRepo: true,
    currentCommit,
    changedFiles: allChanges,
    untrackedFiles: untracked,
  };
}

/**
 * Get all tracked files in the repository (faster than fs scan for many files)
 */
export async function getAllTrackedFiles(projectRoot: string): Promise<string[] | null> {
  try {
    const { stdout } = await execAsync("git ls-files", {
      cwd: projectRoot,
      timeout: 10000,
      maxBuffer: 50 * 1024 * 1024, // 50MB for large repos
    });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return null;
  }
}
