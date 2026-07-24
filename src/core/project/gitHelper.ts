/**
 * v4.3.3: Git helper for incremental indexing
 * Uses git diff to detect changed files instead of full filesystem scan.
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface GitCommandOptions {
  maxBuffer: number;
  timeout: number;
}

export type GitCommandRunner = (
  projectRoot: string,
  args: readonly string[],
  options: GitCommandOptions,
) => Promise<string>;

const defaultGitCommandRunner: GitCommandRunner = async (projectRoot, args, options) => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: projectRoot,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
  });
  return stdout;
};

function parseGitPaths(stdout: string): string[] {
  return stdout.trim().split("\n").filter(Boolean);
}

export interface GitStatus {
  isGitRepo: boolean;
  reliable: boolean;
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
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Get the current HEAD commit SHA
 */
export async function getHeadCommit(
  projectRoot: string,
  commandRunner: GitCommandRunner = defaultGitCommandRunner,
): Promise<string | null> {
  try {
    const stdout = await commandRunner(projectRoot, ["rev-parse", "HEAD"], {
      maxBuffer: 1024 * 1024,
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
  commandRunner: GitCommandRunner,
): Promise<string[] | null> {
  try {
    const stdout = await commandRunner(projectRoot, ["diff", "--name-only", fromCommit, toCommit, "--"], {
      maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
      timeout: 10000,
    });
    return parseGitPaths(stdout);
  } catch {
    return null;
  }
}

/**
 * Get list of uncommitted changed files (staged and unstaged)
 */
async function getUncommittedChanges(
  projectRoot: string,
  currentCommit: string,
  commandRunner: GitCommandRunner,
): Promise<string[] | null> {
  try {
    const stdout = await commandRunner(projectRoot, ["diff", "--name-only", currentCommit, "--"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
    });
    return parseGitPaths(stdout);
  } catch {
    return null;
  }
}

/**
 * Get list of untracked files (not in .gitignore)
 */
async function getUntrackedFiles(
  projectRoot: string,
  commandRunner: GitCommandRunner,
): Promise<string[] | null> {
  try {
    const stdout = await commandRunner(projectRoot, ["ls-files", "--others", "--exclude-standard"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
    });
    return parseGitPaths(stdout);
  } catch {
    return null;
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
  commandRunner: GitCommandRunner = defaultGitCommandRunner,
): Promise<GitStatus> {
  const isRepo = await isGitRepository(projectRoot);
  if (!isRepo) {
    return { isGitRepo: false, reliable: false };
  }

  const currentCommit = await getHeadCommit(projectRoot, commandRunner);
  if (!currentCommit) {
    return { isGitRepo: true, reliable: false };
  }

  // Always get uncommitted changes and untracked files
  const [uncommitted, untracked] = await Promise.all([
    getUncommittedChanges(projectRoot, currentCommit, commandRunner),
    getUntrackedFiles(projectRoot, commandRunner),
  ]);
  if (uncommitted === null || untracked === null) {
    return { isGitRepo: true, currentCommit, reliable: false };
  }

  // If no previous index or different commit, get inter-commit diff
  let committedChanges: string[] = [];
  if (lastIndexedCommit && lastIndexedCommit !== currentCommit) {
    const changedBetweenCommits = await getChangedFilesBetweenCommits(
      projectRoot,
      lastIndexedCommit,
      currentCommit,
      commandRunner,
    );
    if (changedBetweenCommits === null) {
      return { isGitRepo: true, currentCommit, reliable: false };
    }
    committedChanges = changedBetweenCommits;
  }

  // Merge and deduplicate all changed files
  const allChanges = [...new Set([...committedChanges, ...uncommitted])];
  const finalCommit = await getHeadCommit(projectRoot, commandRunner);
  if (!finalCommit || finalCommit !== currentCommit) {
    return { isGitRepo: true, currentCommit, reliable: false };
  }

  return {
    isGitRepo: true,
    reliable: true,
    currentCommit,
    changedFiles: allChanges,
    untrackedFiles: untracked,
  };
}

/**
 * Get all tracked files in the repository (faster than fs scan for many files)
 */
export async function getAllTrackedFiles(
  projectRoot: string,
  commandRunner: GitCommandRunner = defaultGitCommandRunner,
): Promise<string[] | null> {
  try {
    const stdout = await commandRunner(projectRoot, ["ls-files"], {
      maxBuffer: 50 * 1024 * 1024, // 50MB for large repos
      timeout: 10000,
    });
    return parseGitPaths(stdout);
  } catch {
    return null;
  }
}
