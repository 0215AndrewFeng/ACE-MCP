import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createTestProjectEnvironment } from "../../test/helpers.js";
import { ProjectRouter } from "./projectRouter.js";

async function writeProjectFile(projectRootPath: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(projectRootPath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

test("project router selects a concrete child project and suppresses its aggregate parent", async () => {
  const env = await createTestProjectEnvironment({
    "README.md": "Workspace containing several independently deployed services.\n",
  });
  const changeProject = path.join(env.projectRootPath, "change-service");
  const refundProject = path.join(env.projectRootPath, "refund-service");

  try {
    await writeProjectFile(
      changeProject,
      "src/FlowSwitcher.ts",
      "export class FlowSwitcher { changeTicketTraffic(): void { console.log('改签 切流'); } }\n",
    );
    await writeProjectFile(
      refundProject,
      "src/RefundInventory.ts",
      "export class RefundInventory { rollbackRefundStock(): void {} }\n",
    );
    await env.indexCoordinator.indexProject(changeProject, "full");
    await env.indexCoordinator.indexProject(refundProject, "full");
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("FlowSwitcher 改签切流", { topK: 3 });

    assert.equal(result.decision, "single");
    assert.equal(result.selectedProjectRootPaths[0], changeProject);
    assert.equal(result.candidates[0]?.projectRootPath, changeProject);
    assert.ok(result.candidates[0]?.evidence.some((item) => item.filePath === "src/FlowSwitcher.ts"));
    assert.equal(result.candidates.some((candidate) => candidate.projectRootPath === env.projectRootPath), false);
  } finally {
    await env.cleanup();
  }
});

test("project router treats compact CJK query components as one covered concept", async () => {
  const env = await createTestProjectEnvironment({
    "src/change-flow.ts": "// 改签 切流 业务逻辑\nexport const changeFlow = true;\n",
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("改签切流");

    assert.equal(result.decision, "single");
    assert.deepEqual(result.selectedProjectRootPaths, [env.projectRootPath]);
    assert.deepEqual(new Set(result.candidates[0]?.matchedTerms), new Set(["改签", "切流"]));
  } finally {
    await env.cleanup();
  }
});

test("project router does not treat a bridge bigram as a covered compact CJK concept", async () => {
  const env = await createTestProjectEnvironment({});

  try {
    const router = new ProjectRouter(
      {
        listProjects: () => [{ projectRootPath: env.projectRootPath, status: "ready" }],
      } as never,
      {
        searchProjectRouteMatches: async () => [{
          filePath: "src/bridge.ts",
          matchedTerms: ["签切"],
          matchText: "签切",
          projectId: "bridge",
          projectRootPath: env.projectRootPath,
          rank: 1,
          source: "lexical" as const,
        }],
      } as never,
    );

    const result = await router.resolve("改签切流");

    assert.equal(result.decision, "abstain");
    assert.deepEqual(result.selectedProjectRootPaths, []);
  } finally {
    await env.cleanup();
  }
});

test("project router does not compose a compact CJK concept from only weak grams", async () => {
  const env = await createTestProjectEnvironment({});

  try {
    const router = new ProjectRouter(
      {
        listProjects: () => [{ projectRootPath: env.projectRootPath, status: "ready" }],
      } as never,
      {
        searchProjectRouteMatches: async () => [{
          filePath: "src/error-code.ts",
          matchedTerms: ["服务", "错误"],
          matchText: "服务 错误",
          projectId: "weak-grams",
          projectRootPath: env.projectRootPath,
          rank: 1,
          source: "lexical" as const,
        }],
      } as never,
    );

    const result = await router.resolve("服务错误码");

    assert.equal(result.decision, "abstain");
    assert.deepEqual(result.selectedProjectRootPaths, []);
  } finally {
    await env.cleanup();
  }
});

test("project router allows one uncovered character in an odd-length compact CJK concept", async () => {
  const env = await createTestProjectEnvironment({
    "src/refund-flow.ts": "// 退款 流程单 业务逻辑\nexport const refundFlow = true;\n",
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("退款流程单");

    assert.equal(result.decision, "single");
    assert.deepEqual(result.selectedProjectRootPaths, [env.projectRootPath]);
  } finally {
    await env.cleanup();
  }
});

test("project router cannot reuse one repeated CJK gram to cover a compact concept", async () => {
  const env = await createTestProjectEnvironment({});
  const exactProject = path.join(env.tempDir, "exact-service");
  const partialProject = path.join(env.tempDir, "partial-service");

  try {
    await writeProjectFile(exactProject, "src/exact.ts", "// 哈哈哈哈 业务逻辑\nexport const exact = true;\n");
    await writeProjectFile(partialProject, "src/partial.ts", "// 哈哈 业务逻辑\nexport const partial = true;\n");
    await env.indexCoordinator.indexProject(exactProject, "full");
    await env.indexCoordinator.indexProject(partialProject, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("哈哈哈哈");

    assert.equal(result.decision, "single");
    assert.deepEqual(result.selectedProjectRootPaths, [exactProject]);
  } finally {
    await env.cleanup();
  }
});

test("project router does not cover a long compact CJK concept with sparse common grams", async () => {
  const env = await createTestProjectEnvironment({
    "src/common.ts": "// 订单 流程 业务逻辑\nexport const common = true;\n",
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("订单退款流程切换");

    assert.equal(result.decision, "abstain");
    assert.deepEqual(result.selectedProjectRootPaths, []);
  } finally {
    await env.cleanup();
  }
});

test("project router does not dilute identifier coverage with excluded CJK query noise", async () => {
  const env = await createTestProjectEnvironment({});
  const identifierProject = path.join(env.tempDir, "identifier-service");
  const noiseProject = path.join(env.tempDir, "noise-service");

  try {
    await writeProjectFile(identifierProject, "README.md", "matchForShow implementation details\n");
    await writeProjectFile(noiseProject, "README.md", "接口的具体业务逻辑\n");
    await env.indexCoordinator.indexProject(identifierProject, "full");
    await env.indexCoordinator.indexProject(noiseProject, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("matchForShow接口的具体业务逻辑");

    assert.equal(result.decision, "single");
    assert.deepEqual(result.selectedProjectRootPaths, [identifierProject]);
    assert.equal(result.candidates.some((candidate) => candidate.projectRootPath === noiseProject), false);
  } finally {
    await env.cleanup();
  }
});

test("project router prefers exact mixed business evidence over generic refund coverage", async () => {
  const env = await createTestProjectEnvironment({});
  const preciseProject = path.join(env.tempDir, "tc-flight-tgq-rule");
  const genericProject = path.join(env.tempDir, "tc-flight-endorse-service");

  try {
    await mkdir(preciseProject, { recursive: true });
    await mkdir(genericProject, { recursive: true });
    const router = new ProjectRouter(
      {
        listProjects: () => [preciseProject, genericProject]
          .map((projectRootPath) => ({ projectRootPath, status: "ready" })),
      } as never,
      {
        searchProjectRouteMatches: async () => [
          {
            filePath: "src/XcalcPreConvertADAdjustProc.java",
            matchedTerms: ["a转d", "refund", "rule"],
            matchText: "A转D refund rule",
            projectId: "precise",
            projectRootPath: preciseProject,
            rank: 1,
            source: "lexical" as const,
          },
          ...Array.from({ length: 5 }, (_, index) => ({
            filePath: `src/GenericRefund${index}.java`,
            matchedTerms: ["转", "历史逻辑", "refund", "rule", "to"],
            matchText: "转 历史逻辑 refund rule to",
            projectId: "generic",
            projectRootPath: genericProject,
            rank: index + 2,
            source: "lexical" as const,
          })),
        ],
      } as never,
    );

    const result = await router.resolve("A转D A转D历史逻辑 refund rule A to D");

    assert.equal(result.decision, "single");
    assert.deepEqual(result.selectedProjectRootPaths, [preciseProject]);
    assert.equal(result.candidates[0]?.projectRootPath, preciseProject);
    assert.ok(result.candidates[0]?.matchedTerms.includes("a转d"));
  } finally {
    await env.cleanup();
  }
});

test("project router anchors mixed business evidence to its owning repository family", async () => {
  const env = await createTestProjectEnvironment({});
  const ruleProject = path.join(env.tempDir, "tc-flight-tgq-rule");
  const coreProject = path.join(env.tempDir, "tc-flight-tgq-core");
  const copiedProject = path.join(env.tempDir, "tc-flight-fdr-core");
  const testHarnessProject = path.join(env.tempDir, "ace-mcp");
  const projects = [ruleProject, coreProject, copiedProject, testHarnessProject];

  try {
    await Promise.all(projects.map((projectRootPath) => mkdir(projectRootPath, { recursive: true })));
    const genericTerms = ["国内", "机票", "退订", "系统", "退规", "计算", "refund", "rule"];
    const router = new ProjectRouter(
      {
        listProjects: () => projects.map((projectRootPath) => ({ projectRootPath, status: "ready" })),
      } as never,
      {
        searchProjectRouteMatches: async () => [
          {
            filePath: "app/common/TgqProcessorEnum.java",
            matchedTerms: [...genericTerms, "a转d"],
            matchText: "A转D refund rule",
            projectId: "rule",
            projectRootPath: ruleProject,
            rank: 1,
            source: "lexical" as const,
          },
          {
            filePath: "app/biz/TgqInstanceHandlerImpl.java",
            matchedTerms: genericTerms,
            matchText: "国内 机票 退订 系统 退规 计算 refund rule",
            projectId: "core",
            projectRootPath: coreProject,
            rank: 2,
            source: "lexical" as const,
          },
          {
            filePath: "src/TgqProcessorEnum.java",
            matchedTerms: [...genericTerms, "a转d"],
            matchText: "A转D refund rule",
            projectId: "copied",
            projectRootPath: copiedProject,
            rank: 3,
            source: "lexical" as const,
          },
          {
            filePath: "src/projectRouter.test.ts",
            matchedTerms: [...genericTerms, "a转d", "a转d历史逻辑"],
            matchText: "国内机票退订系统 退规计算 A转D A转D历史逻辑 refund rule",
            projectId: "harness",
            projectRootPath: testHarnessProject,
            rank: 4,
            source: "lexical" as const,
          },
        ],
      } as never,
    );

    const result = await router.resolve(
      "国内机票退订系统 退规计算 A转D A转D历史逻辑 refund rule A to D",
      { topK: 4 },
    );

    assert.equal(result.decision, "multiple");
    assert.deepEqual(result.selectedProjectRootPaths, [ruleProject, coreProject]);
    assert.deepEqual(
      new Set(result.candidates.slice(0, 2).map((candidate) => candidate.projectRootPath)),
      new Set([ruleProject, coreProject]),
    );
  } finally {
    await env.cleanup();
  }
});

test("project router keeps equally relevant projects when a keyword is shared", async () => {
  const env = await createTestProjectEnvironment({});
  const firstProject = path.join(env.tempDir, "service-a");
  const secondProject = path.join(env.tempDir, "service-b");

  try {
    await writeProjectFile(
      firstProject,
      "src/SharedTimeoutController.ts",
      "export class SharedTimeoutController { handleTimeout(): void {} }\n",
    );
    await writeProjectFile(
      secondProject,
      "src/SharedTimeoutController.ts",
      "export class SharedTimeoutController { handleTimeout(): void {} }\n",
    );
    await env.indexCoordinator.indexProject(firstProject, "full");
    await env.indexCoordinator.indexProject(secondProject, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("SharedTimeoutController", { topK: 3 });

    assert.equal(result.decision, "multiple");
    assert.deepEqual(
      new Set(result.selectedProjectRootPaths),
      new Set([firstProject, secondProject]),
    );
    assert.equal(
      result.candidates
        .filter((candidate) => result.selectedProjectRootPaths.includes(candidate.projectRootPath))
        .every((candidate) => candidate.evidence.some((evidence) => evidence.source === "symbol")),
      true,
    );
  } finally {
    await env.cleanup();
  }
});

test("project router keeps equally strong projects despite asymmetric duplicate evidence", async () => {
  const env = await createTestProjectEnvironment({});
  const largeProject = path.join(env.tempDir, "large-service");
  const smallProject = path.join(env.tempDir, "small-service");

  try {
    await mkdir(largeProject, { recursive: true });
    await mkdir(smallProject, { recursive: true });
    const largeMatches = Array.from({ length: 60 }, (_, index) => ({
      filePath: `src/duplicate-${index}.ts`,
      matchText: "zebraterm business logic",
      projectId: "large",
      projectRootPath: largeProject,
      rank: index + 1,
      source: "lexical" as const,
    }));
    const router = new ProjectRouter(
      {
        listProjects: () => [largeProject, smallProject].map((projectRootPath) => ({ projectRootPath, status: "ready" })),
      } as never,
      {
        searchProjectRouteMatches: async () => [
          ...largeMatches,
          {
            filePath: "src/business.ts",
            matchText: "zebraterm business logic",
            projectId: "small",
            projectRootPath: smallProject,
            rank: 61,
            source: "lexical" as const,
          },
        ],
      } as never,
    );

    const result = await router.resolve("zebraterm business");

    assert.equal(result.decision, "multiple");
    assert.deepEqual(new Set(result.selectedProjectRootPaths), new Set([largeProject, smallProject]));
  } finally {
    await env.cleanup();
  }
});

test("project router recalls a small project through real duplicate-heavy lexical search", async () => {
  const env = await createTestProjectEnvironment({});
  const largeProject = path.join(env.tempDir, "large-service");
  const smallProject = path.join(env.tempDir, "small-service");

  try {
    await Promise.all(Array.from({ length: 60 }, (_, index) => writeProjectFile(
      largeProject,
      `src/route-${index}.ts`,
      `// ${"zebraterm business ".repeat(8)}\nexport const route${index} = ${index};\n`,
    )));
    await writeProjectFile(
      smallProject,
      "src/route.ts",
      `// zebraterm business ${"padding ".repeat(100)}\nexport const route = true;\n`,
    );
    await env.indexCoordinator.indexProject(largeProject, "full");
    await env.indexCoordinator.indexProject(smallProject, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("zebraterm business");

    assert.equal(result.decision, "multiple");
    assert.deepEqual(new Set(result.selectedProjectRootPaths), new Set([largeProject, smallProject]));
  } finally {
    await env.cleanup();
  }
});

test("project router keeps duplicate-heavy lexical routing bounded on a large corpus", async () => {
  const env = await createTestProjectEnvironment({});
  const largeProject = path.join(env.tempDir, "large-service");
  const smallProject = path.join(env.tempDir, "small-service");

  try {
    const repeatedBody = `// ${"zebraterm business ".repeat(8)}${"padding ".repeat(600)}\n`;
    await Promise.all(Array.from({ length: 1_000 }, (_, index) => writeProjectFile(
      largeProject,
      `src/route-${index}.ts`,
      `${repeatedBody}export const route${index} = ${index};\n`,
    )));
    await writeProjectFile(
      smallProject,
      "src/route.ts",
      `// zebraterm business ${"padding ".repeat(800)}\nexport const route = true;\n`,
    );
    await env.indexCoordinator.indexProject(largeProject, "full");
    await env.indexCoordinator.indexProject(smallProject, "full");

    const rawMatches = env.store.searchProjectRoutes(
      "zebraterm* OR business*",
      [],
      50,
      [],
      ["zebraterm", "business"],
    );
    const result = await new ProjectRouter(env.store, env.searchService).resolve("zebraterm business");

    assert.deepEqual(new Set(rawMatches.map((match) => match.projectRootPath)), new Set([largeProject, smallProject]));
    assert.ok(rawMatches.every((match) => match.matchText.length <= 4_096));
    assert.ok(rawMatches.every((match) => match.matchText.includes("zebraterm") && match.matchText.includes("business")));
    assert.ok(rawMatches.every((match) => new Set(match.matchedTerms).size === 2));
    assert.equal(result.decision, "multiple");
    assert.deepEqual(new Set(result.selectedProjectRootPaths), new Set([largeProject, smallProject]));
    assert.ok(result.candidates.every((candidate) => candidate.evidence.length <= 5));
    assert.ok(result.durationMs < 1_000, `expected bounded routing under 1000ms, received ${result.durationMs}ms`);
  } finally {
    await env.cleanup();
  }
});

test("project router keeps one project single despite abundant duplicate evidence", async () => {
  const env = await createTestProjectEnvironment({});
  const projectRootPath = path.join(env.tempDir, "large-service");

  try {
    await mkdir(projectRootPath, { recursive: true });
    const router = new ProjectRouter(
      {
        listProjects: () => [{ projectRootPath, status: "ready" }],
      } as never,
      {
        searchProjectRouteMatches: async () => Array.from({ length: 60 }, (_, index) => ({
          filePath: `src/duplicate-${index}.ts`,
          matchText: "zebraterm business logic",
          projectId: "large",
          projectRootPath,
          rank: index + 1,
          source: "lexical" as const,
        })),
      } as never,
    );

    const result = await router.resolve("zebraterm business");

    assert.equal(result.decision, "single");
    assert.deepEqual(result.selectedProjectRootPaths, [projectRootPath]);
  } finally {
    await env.cleanup();
  }
});

test("project router counts lexical terms that are farther apart than the route snippet", async () => {
  const env = await createTestProjectEnvironment({
    "src/distant.ts": `// zebraterm ${"padding ".repeat(100)}business\nexport const route = true;\n`,
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("zebraterm business");

    assert.equal(result.decision, "single");
    assert.deepEqual(result.selectedProjectRootPaths, [env.projectRootPath]);
  } finally {
    await env.cleanup();
  }
});

test("project router does not count lexical substring collisions as matched terms", async () => {
  const env = await createTestProjectEnvironment({
    "src/collision.ts": "// preorder business logic\nexport const route = true;\n",
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("order business");

    assert.equal(result.decision, "abstain");
    assert.deepEqual(result.selectedProjectRootPaths, []);
  } finally {
    await env.cleanup();
  }
});

test("project router does not promote a low-coverage duplicate-heavy project to ambiguity", async () => {
  const env = await createTestProjectEnvironment({});
  const strongProject = path.join(env.tempDir, "strong-service");
  const weakProject = path.join(env.tempDir, "weak-service");

  try {
    await mkdir(strongProject, { recursive: true });
    await mkdir(weakProject, { recursive: true });
    const weakMatches = Array.from({ length: 60 }, (_, index) => ({
      filePath: `src/duplicate-${index}.ts`,
      matchText: "zebraterm helper logic",
      projectId: "weak",
      projectRootPath: weakProject,
      rank: index + 2,
      source: "lexical" as const,
    }));
    const router = new ProjectRouter(
      {
        listProjects: () => [strongProject, weakProject].map((projectRootPath) => ({ projectRootPath, status: "ready" })),
      } as never,
      {
        searchProjectRouteMatches: async () => [
          {
            filePath: "src/business.ts",
            matchText: "zebraterm business logic",
            projectId: "strong",
            projectRootPath: strongProject,
            rank: 1,
            source: "lexical" as const,
          },
          ...weakMatches,
        ],
      } as never,
    );

    const result = await router.resolve("zebraterm business");

    assert.equal(result.decision, "single");
    assert.deepEqual(result.selectedProjectRootPaths, [strongProject]);
    assert.deepEqual(result.candidates.find((candidate) => candidate.projectRootPath === weakProject)?.matchedTerms, ["zebraterm"]);
  } finally {
    await env.cleanup();
  }
});

test("project router abstains when no indexed project contains useful evidence", async () => {
  const env = await createTestProjectEnvironment({
    "src/OrderService.ts": "export class OrderService { createOrder(): void {} }\n",
  });

  try {
    await env.indexCoordinator.indexProject(env.projectRootPath, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve("tomorrow weather forecast", { topK: 3 });

    assert.equal(result.decision, "abstain");
    assert.deepEqual(result.selectedProjectRootPaths, []);
    assert.deepEqual(result.candidates, []);
  } finally {
    await env.cleanup();
  }
});

test("project router abstains when a query contains only weak shared terms", async () => {
  const env = await createTestProjectEnvironment({});
  const firstProject = path.join(env.tempDir, "service-a");
  const secondProject = path.join(env.tempDir, "service-b");

  try {
    await writeProjectFile(
      firstProject,
      "src/OrderService.ts",
      "// shared service timeout handling\nexport class OrderService { handleTimeout(): void {} }\n",
    );
    await writeProjectFile(
      secondProject,
      "src/UserController.ts",
      "// shared controller timeout handling\nexport class UserController { handleTimeout(): void {} }\n",
    );
    await env.indexCoordinator.indexProject(firstProject, "full");
    await env.indexCoordinator.indexProject(secondProject, "full");

    const result = await new ProjectRouter(env.store, env.searchService).resolve(
      "service controller timeout",
      { topK: 3 },
    );

    assert.equal(result.decision, "abstain");
    assert.deepEqual(result.selectedProjectRootPaths, []);
  } finally {
    await env.cleanup();
  }
});

test("project router abstains from weak terms without querying the global index", async () => {
  const router = new ProjectRouter(
    {
      listProjects() {
        throw new Error("project listing should not run for weak terms");
      },
    } as never,
    {
      searchProjectRouteMatches() {
        throw new Error("global search should not run for weak terms");
      },
    } as never,
  );

  const result = await router.resolve("service controller timeout");

  assert.equal(result.decision, "abstain");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.selectedProjectRootPaths, []);

  const compactCjkResult = await router.resolve("服务超时");
  assert.equal(compactCjkResult.decision, "abstain");
  assert.deepEqual(compactCjkResult.candidates, []);
});

test("project router keeps ambiguity when the caller requests one candidate", async () => {
  const env = await createTestProjectEnvironment({});
  const firstProject = path.join(env.tempDir, "service-a");
  const secondProject = path.join(env.tempDir, "service-b");

  try {
    await mkdir(firstProject, { recursive: true });
    await mkdir(secondProject, { recursive: true });
    const router = new ProjectRouter(
      {
        listProjects: () => [firstProject, secondProject].map((projectRootPath) => ({ projectRootPath, status: "ready" })),
      } as never,
      {
        searchProjectRouteMatches: async () => [firstProject, secondProject].map((projectRootPath, index) => ({
          filePath: "src/SharedThing.ts",
          matchText: "SharedThing",
          projectId: String(index),
          projectRootPath,
          rank: index + 1,
          source: "symbol" as const,
          symbol: "SharedThing",
        })),
      } as never,
    );

    const result = await router.resolve("SharedThing", { topK: 1 });

    assert.equal(result.decision, "multiple");
    assert.deepEqual(new Set(result.selectedProjectRootPaths), new Set([firstProject, secondProject]));
    assert.equal(result.candidates.length, 2);
  } finally {
    await env.cleanup();
  }
});

test("project router abstains from a single low-coverage tail match", async () => {
  const env = await createTestProjectEnvironment({});

  try {
    const router = new ProjectRouter(
      {
        listProjects: () => [{ projectRootPath: env.projectRootPath, status: "ready" }],
      } as never,
      {
        searchProjectRouteMatches: async () => [{
          filePath: "src/Unrelated.ts",
          matchText: "unicorn",
          projectId: "unrelated",
          projectRootPath: env.projectRootPath,
          rank: 50,
          source: "lexical" as const,
        }],
      } as never,
    );

    const result = await router.resolve("unicorn alpha beta gamma");

    assert.equal(result.decision, "abstain");
    assert.deepEqual(result.selectedProjectRootPaths, []);
    assert.ok((result.candidates[0]?.confidence ?? 1) < 0.5);
  } finally {
    await env.cleanup();
  }
});

test("project router caps repeated low-ranked evidence per project", async () => {
  const env = await createTestProjectEnvironment({});
  const exactProject = path.join(env.tempDir, "exact-service");
  const noisyProject = path.join(env.tempDir, "noisy-service");

  try {
    await mkdir(exactProject, { recursive: true });
    await mkdir(noisyProject, { recursive: true });
    const noisyMatches = Array.from({ length: 100 }, (_, index) => ({
      filePath: `src/noise-${index}.ts`,
      matchText: "UniqueSymbol",
      projectId: "noisy",
      projectRootPath: noisyProject,
      rank: 50,
      source: "lexical" as const,
    }));
    const router = new ProjectRouter(
      {
        listProjects: () => [exactProject, noisyProject].map((projectRootPath) => ({ projectRootPath, status: "ready" })),
      } as never,
      {
        searchProjectRouteMatches: async () => [
          {
            filePath: "src/UniqueSymbol.ts",
            matchText: "UniqueSymbol",
            projectId: "exact",
            projectRootPath: exactProject,
            rank: 1,
            source: "symbol" as const,
            symbol: "UniqueSymbol",
          },
          ...noisyMatches,
        ],
      } as never,
    );

    const result = await router.resolve("UniqueSymbol");

    assert.equal(result.decision, "single");
    assert.deepEqual(result.selectedProjectRootPaths, [exactProject]);
  } finally {
    await env.cleanup();
  }
});

test("project router suppresses aggregate roots using every registered child", async () => {
  const env = await createTestProjectEnvironment({});
  const childProject = path.join(env.projectRootPath, "service-a");
  const unavailableChild = path.join(env.projectRootPath, "service-b");
  let excludedProjectRootPaths: string[] = [];

  try {
    await mkdir(childProject, { recursive: true });
    const router = new ProjectRouter(
      {
        listProjects: () => [
          { projectRootPath: env.projectRootPath, status: "ready" },
          { projectRootPath: childProject, status: "ready" },
          { projectRootPath: unavailableChild, status: "error" },
        ],
      } as never,
      {
        searchProjectRouteMatches: async (_query: string, _limit: number, excluded: string[]) => {
          excludedProjectRootPaths = excluded;
          return [
            {
              filePath: "service-a/src/ChildRoute.ts",
              matchText: "ChildRoute",
              projectId: "parent",
              projectRootPath: env.projectRootPath,
              rank: 1,
              source: "symbol" as const,
              symbol: "ChildRoute",
            },
            {
              filePath: "src/ChildRoute.ts",
              matchText: "ChildRoute",
              projectId: "child",
              projectRootPath: childProject,
              rank: 2,
              source: "symbol" as const,
              symbol: "ChildRoute",
            },
          ];
        },
      } as never,
    );

    const result = await router.resolve("ChildRoute");

    assert.equal(excludedProjectRootPaths.includes(env.projectRootPath), true);
    assert.equal(result.candidates.some((candidate) => candidate.projectRootPath === env.projectRootPath), false);
    assert.deepEqual(result.selectedProjectRootPaths, [childProject]);
  } finally {
    await env.cleanup();
  }
});

test("project router evaluates golden cases independently from code-result quality", async () => {
  const env = await createTestProjectEnvironment({});
  const changeProject = path.join(env.tempDir, "change-service");

  try {
    await writeProjectFile(
      changeProject,
      "src/FlowSwitcher.ts",
      "export class FlowSwitcher { changeTicketTraffic(): void {} }\n",
    );
    await env.indexCoordinator.indexProject(changeProject, "full");
    const router = new ProjectRouter(env.store, env.searchService);

    const evaluation = await router.evaluate([
      {
        expectedDecision: "single",
        expectedProjects: [changeProject],
        name: "exact change switch symbol",
        query: "FlowSwitcher",
      },
      {
        expectedDecision: "abstain",
        expectedProjects: [],
        name: "unrelated question",
        query: "tomorrow weather forecast",
      },
    ]);

    assert.equal(evaluation.summary.total, 2);
    assert.equal(evaluation.summary.decisionAccuracy, 1);
    assert.equal(evaluation.summary.top1Accuracy, 1);
    assert.equal(evaluation.summary.recallAt3, 1);
    assert.equal(evaluation.summary.meanReciprocalRank, 1);
    assert.equal(evaluation.cases.every((item) => item.passed), true);
  } finally {
    await env.cleanup();
  }
});

test("project router evaluation calculates recall at three from ranked candidates", async () => {
  const expectedProject = "/work/refund-service";
  const router = new ProjectRouter({} as never, {} as never);
  router.resolve = async () => ({
    candidates: [
      {
        confidence: 0.6,
        evidence: [],
        matchedTerms: ["timeout"],
        projectRootPath: "/work/change-service",
        score: 1.2,
      },
      {
        confidence: 0.3,
        evidence: [],
        matchedTerms: ["rollback"],
        projectRootPath: expectedProject,
        score: 0.6,
      },
      {
        confidence: 0.1,
        evidence: [],
        matchedTerms: ["inventory"],
        projectRootPath: "/work/order-service",
        score: 0.2,
      },
    ],
    decision: "single",
    durationMs: 1,
    query: "refund timeout rollback inventory",
    selectedProjectRootPaths: ["/work/change-service"],
  });

  const evaluation = await router.evaluate([
    {
      expectedDecision: "single",
      expectedProjects: [expectedProject],
      name: "relevant project is the second-ranked candidate",
      query: "refund timeout rollback inventory",
    },
  ]);

  assert.equal(evaluation.summary.top1Accuracy, 0);
  assert.equal(evaluation.summary.recallAt3, 1);
  assert.equal(evaluation.summary.meanReciprocalRank, 0.5);
});

test("project router evaluation rejects selected projects beyond the expected set", async () => {
  const router = new ProjectRouter({} as never, {} as never);
  router.resolve = async () => ({
    candidates: ["/work/a", "/work/b", "/work/extra"].map((projectRootPath, index) => ({
      confidence: 0.4 - index * 0.1,
      evidence: [],
      matchedTerms: ["shared"],
      projectRootPath,
      score: 1 - index * 0.1,
    })),
    decision: "multiple",
    durationMs: 1,
    query: "shared flow",
    selectedProjectRootPaths: ["/work/a", "/work/b", "/work/extra"],
  });

  const evaluation = await router.evaluate([
    {
      expectedDecision: "multiple",
      expectedProjects: ["/work/a", "/work/b"],
      name: "unexpected extra project",
      query: "shared flow",
    },
  ]);

  assert.equal(evaluation.cases[0]?.passed, false);
});
