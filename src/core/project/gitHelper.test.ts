import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { getGitChangedFiles, type GitCommandRunner } from "./gitHelper.js";

const execFileAsync = promisify(execFile);

async function runGit(projectRootPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: projectRootPath });
  return stdout.trim();
}

async function createGitProject(): Promise<{
  cleanup(): Promise<void>;
  head: string;
  projectRootPath: string;
}> {
  const projectRootPath = await mkdtemp(path.join(os.tmpdir(), "ace-mcp-git-helper-"));
  await Promise.all([
    writeFile(path.join(projectRootPath, "modified.ts"), "export const value = 1;\n", "utf8"),
    writeFile(path.join(projectRootPath, "deleted.ts"), "export const removed = true;\n", "utf8"),
  ]);
  await runGit(projectRootPath, ["init", "-q"]);
  await runGit(projectRootPath, ["config", "user.email", "ace-mcp-test@example.invalid"]);
  await runGit(projectRootPath, ["config", "user.name", "ace-mcp test"]);
  await runGit(projectRootPath, ["add", "--all"]);
  await runGit(projectRootPath, ["commit", "-qm", "initial"]);
  const head = await runGit(projectRootPath, ["rev-parse", "HEAD"]);
  return {
    cleanup: () => rm(projectRootPath, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 }),
    head,
    projectRootPath,
  };
}

test("clean Git status is reliable and empty at the indexed commit", async () => {
  const project = await createGitProject();
  try {
    const status = await getGitChangedFiles(project.projectRootPath, project.head);

    assert.equal(status.isGitRepo, true);
    assert.equal(status.reliable, true);
    assert.equal(status.currentCommit, project.head);
    assert.deepEqual(status.changedFiles, []);
    assert.deepEqual(status.untrackedFiles, []);
  } finally {
    await project.cleanup();
  }
});

test("Git status reports tracked modifications, tracked deletions, and untracked files", async () => {
  const project = await createGitProject();
  try {
    await writeFile(path.join(project.projectRootPath, "modified.ts"), "export const value = 2;\n", "utf8");
    await rm(path.join(project.projectRootPath, "deleted.ts"));
    await mkdir(path.join(project.projectRootPath, "new"));
    await writeFile(path.join(project.projectRootPath, "new", "untracked.ts"), "export const fresh = true;\n", "utf8");

    const status = await getGitChangedFiles(project.projectRootPath, project.head);

    assert.equal(status.reliable, true);
    assert.deepEqual(status.changedFiles?.sort(), ["deleted.ts", "modified.ts"]);
    assert.deepEqual(status.untrackedFiles, ["new/untracked.ts"]);
  } finally {
    await project.cleanup();
  }
});

test("an invalid indexed base commit makes Git status unreliable", async () => {
  const project = await createGitProject();
  try {
    const status = await getGitChangedFiles(project.projectRootPath, "0000000000000000000000000000000000000000");

    assert.equal(status.isGitRepo, true);
    assert.equal(status.reliable, false);
    assert.equal(status.changedFiles, undefined);
  } finally {
    await project.cleanup();
  }
});

test("a Git command failure is not reported as a reliable empty change set", async () => {
  const project = await createGitProject();
  try {
    const status = await getGitChangedFiles(
      project.projectRootPath,
      project.head,
      async () => {
        throw new Error("git command failed");
      },
    );

    assert.equal(status.isGitRepo, true);
    assert.equal(status.reliable, false);
    assert.equal(status.changedFiles, undefined);
    assert.equal(status.untrackedFiles, undefined);
  } finally {
    await project.cleanup();
  }
});

test("Git status stays conservative when HEAD moves after the commit is captured", async () => {
  const project = await createGitProject();
  let moveHead: Promise<void> | undefined;
  const commandRunner: GitCommandRunner = async (projectRootPath, args, options) => {
    if (args[0] !== "rev-parse") {
      moveHead ??= (async () => {
        await writeFile(path.join(projectRootPath, "modified.ts"), "export const value = 2;\n", "utf8");
        await runGit(projectRootPath, ["add", "--all"]);
        await runGit(projectRootPath, ["commit", "-qm", "move head"]);
      })();
      await moveHead;
    }
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: projectRootPath,
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
    });
    return stdout;
  };

  try {
    const status = await getGitChangedFiles(project.projectRootPath, project.head, commandRunner);

    assert.equal(status.reliable, false);
    assert.equal(status.changedFiles, undefined);
    assert.notEqual(await runGit(project.projectRootPath, ["rev-parse", "HEAD"]), project.head);
  } finally {
    await project.cleanup();
  }
});

test("Git status reports files committed after the indexed base", async () => {
  const project = await createGitProject();
  try {
    await writeFile(path.join(project.projectRootPath, "modified.ts"), "export const value = 2;\n", "utf8");
    await runGit(project.projectRootPath, ["add", "--all"]);
    await runGit(project.projectRootPath, ["commit", "-qm", "second"]);
    const currentCommit = await runGit(project.projectRootPath, ["rev-parse", "HEAD"]);

    const status = await getGitChangedFiles(project.projectRootPath, project.head);

    assert.equal(status.reliable, true);
    assert.equal(status.currentCommit, currentCommit);
    assert.deepEqual(status.changedFiles, ["modified.ts"]);
    assert.deepEqual(status.untrackedFiles, []);
  } finally {
    await project.cleanup();
  }
});

test("Git status becomes unreliable when HEAD moves after diff collection", async () => {
  const project = await createGitProject();
  let revParseCalls = 0;
  const commandRunner: GitCommandRunner = async (projectRootPath, args, options) => {
    if (args[0] === "rev-parse") {
      revParseCalls += 1;
      if (revParseCalls === 2) {
        await writeFile(path.join(projectRootPath, "modified.ts"), "export const value = 2;\n", "utf8");
        await runGit(projectRootPath, ["add", "--all"]);
        await runGit(projectRootPath, ["commit", "-qm", "late head move"]);
      }
    }
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: projectRootPath,
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
    });
    return stdout;
  };

  try {
    const status = await getGitChangedFiles(project.projectRootPath, project.head, commandRunner);

    assert.equal(revParseCalls, 2);
    assert.equal(status.reliable, false);
    assert.equal(status.changedFiles, undefined);
  } finally {
    await project.cleanup();
  }
});
