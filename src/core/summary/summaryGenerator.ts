import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../common/logger.js";
import type { LlmClient } from "../llm/llmClient.js";
import type { SQLiteStore } from "../storage/sqliteStore.js";
import type { ProjectSummary, SummaryGenerationResult, ModuleSummary, ModuleRelationship } from "./types.js";

const SUMMARIES_DIR = ".ace-mcp/summaries";

export class SummaryGenerator {
  constructor(
    private store: SQLiteStore,
    private llmClient: LlmClient,
    private logger: Logger,
  ) {}

  async generateProjectSummary(projectRootPath: string, projectId: string): Promise<SummaryGenerationResult> {
    const startMs = Date.now();

    if (!this.llmClient.isConfigured()) {
      throw new Error("LLM API not configured. Set ACE_MCP_LLM_API_URL and ACE_MCP_LLM_API_KEY.");
    }

    // 1. Get all indexed files
    const files = this.store.listProjectFiles(projectId);
    if (files.length === 0) {
      throw new Error("Project has no indexed files. Run index_project first.");
    }

    // 2. Group files by top-level directory → modules
    const moduleMap = new Map<string, typeof files>();
    for (const file of files) {
      const parts = file.relativePath.split("/");
      const moduleName = parts.length > 1 ? parts[0] : "(root)";
      const list = moduleMap.get(moduleName) ?? [];
      list.push(file);
      moduleMap.set(moduleName, list);
    }

    // 3. Get symbols per module and generate summaries
    const modules: ModuleSummary[] = [];
    let totalPrompt = 0;
    let totalCompletion = 0;

    for (const [moduleName, moduleFiles] of moduleMap) {
      // Get symbols for these files
      const definitions = this.store.findDefinitions(
        projectId,
        "*",
        200,
        { pathPrefix: moduleName === "(root)" ? undefined : moduleName },
      );

      const symbolList = definitions
        .map((d) => `  ${d.kind} ${d.fullName} (${d.filePath}:${d.line}) — ${d.signature.slice(0, 120)}`)
        .join("\n");

      const fileList = moduleFiles
        .map((f) => `  ${f.relativePath} (${f.language}, ${f.lineCount} lines)`)
        .join("\n");

      const prompt = `Analyze this code module and provide a concise description (2-3 sentences) of its responsibility and purpose.

Module: ${moduleName}
Files (${moduleFiles.length}):
${fileList}

Key symbols (${definitions.length}):
${symbolList || "  (no symbols extracted)"}

Respond with ONLY the description, no prefix or formatting.`;

      try {
        const result = await this.llmClient.complete({
          messages: [
            { role: "system", content: "You are a code architecture analyst. Be concise and precise." },
            { role: "user", content: prompt },
          ],
          maxTokens: 256,
        });

        totalPrompt += result.usage.promptTokens;
        totalCompletion += result.usage.completionTokens;

        modules.push({
          path: moduleName,
          description: (result.content ?? "").trim(),
          keySymbols: definitions.slice(0, 10).map((d) => d.fullName),
          fileCount: moduleFiles.length,
        });
      } catch (error) {
        this.logger.warn("Failed to summarize module", { moduleName, error: String(error) });
        modules.push({
          path: moduleName,
          description: "(summary generation failed)",
          keySymbols: definitions.slice(0, 10).map((d) => d.fullName),
          fileCount: moduleFiles.length,
        });
      }
    }

    // 4. Build relationships from import data (lightweight)
    const relationships: ModuleRelationship[] = [];
    // We'll derive from the module names for now — import graph is complex
    // A simple approach: if module A has files importing from module B's path
    for (const [modName, modFiles] of moduleMap) {
      const fileIds = new Set(modFiles.map((f) => f.fileId));
      // Check if any definitions from this module are referenced by other modules
      // This is simplified — just list inter-module dependencies
      for (const [otherMod] of moduleMap) {
        if (otherMod === modName) continue;
        // Check if files in modName import from otherMod
        const hasImport = modFiles.some((f) => {
          const defs = this.store.findDefinitions(projectId, "*", 5, { pathPrefix: otherMod === "(root)" ? undefined : otherMod });
          return defs.length > 0; // simplified
        });
        // We'll skip this complex check for now — relationships come from the architecture overview
      }
    }

    // 5. Generate architecture overview
    const moduleOverview = modules
      .map((m) => `- **${m.path}** (${m.fileCount} files): ${m.description}`)
      .join("\n");

    let architecture = "";
    try {
      const archResult = await this.llmClient.complete({
        messages: [
          { role: "system", content: "You are a code architecture analyst. Write in markdown." },
          {
            role: "user",
            content: `Based on these module summaries, write a concise project architecture overview (3-5 paragraphs).

Project: ${path.basename(projectRootPath)}
Total files: ${files.length}
Modules:
${moduleOverview}

Include: overall purpose, key architectural patterns, module relationships, and data flow.`,
          },
        ],
        maxTokens: 1024,
      });

      totalPrompt += archResult.usage.promptTokens;
      totalCompletion += archResult.usage.completionTokens;
      architecture = (archResult.content ?? "").trim();
    } catch (error) {
      this.logger.warn("Failed to generate architecture overview", { error: String(error) });
      architecture = `# ${path.basename(projectRootPath)}\n\nArchitecture overview generation failed.\n\n## Modules\n\n${moduleOverview}`;
    }

    // 6. Persist
    const outputDir = path.join(projectRootPath, SUMMARIES_DIR);
    const modulesDir = path.join(outputDir, "modules");
    await mkdir(modulesDir, { recursive: true });

    const summary: ProjectSummary = {
      version: 1,
      generatedAt: new Date().toISOString(),
      projectRootPath,
      architecture,
      modules,
      relationships,
      tokensUsed: { prompt: totalPrompt, completion: totalCompletion },
    };

    const filesWritten: string[] = [];

    // project-summary.json
    const summaryPath = path.join(outputDir, "project-summary.json");
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    filesWritten.push("project-summary.json");

    // architecture.md
    const archPath = path.join(outputDir, "architecture.md");
    await writeFile(archPath, architecture, "utf8");
    filesWritten.push("architecture.md");

    // per-module md
    for (const mod of modules) {
      const safeName = mod.path.replace(/[/\\]/g, "_");
      const modPath = path.join(modulesDir, `${safeName}.md`);
      const content = `# ${mod.path}\n\n${mod.description}\n\n## Key Symbols\n\n${mod.keySymbols.map((s) => `- \`${s}\``).join("\n") || "(none)"}\n\n**Files**: ${mod.fileCount}\n`;
      await writeFile(modPath, content, "utf8");
      filesWritten.push(`modules/${safeName}.md`);
    }

    const durationMs = Date.now() - startMs;
    this.logger.info("Project summary generated", {
      durationMs,
      moduleCount: modules.length,
      tokensUsed: { prompt: totalPrompt, completion: totalCompletion },
    });

    return {
      outputDir,
      filesWritten,
      moduleCount: modules.length,
      tokensUsed: { prompt: totalPrompt, completion: totalCompletion },
      durationMs,
    };
  }

  async loadSummary(projectRootPath: string): Promise<ProjectSummary | null> {
    const summaryPath = path.join(projectRootPath, SUMMARIES_DIR, "project-summary.json");
    try {
      const content = await readFile(summaryPath, "utf8");
      return JSON.parse(content) as ProjectSummary;
    } catch {
      return null;
    }
  }
}
