import type { Express, Request, Response } from "express";

import type { WebAppDependencies } from "../types.js";

export function registerAdminRoutes(app: Express, dependencies: WebAppDependencies): void {
  // ── LLM config endpoints ──────────────────────────────
  app.get("/api/llm/config", (_req: Request, res: Response) => {
    res.json(dependencies.llmClient.getConfig());
  });

  app.post("/api/llm/config", async (req: Request, res: Response) => {
    const { apiUrl, apiKey, model } = req.body;
    if (!apiUrl || !apiKey) {
      res.status(400).json({ error: "apiUrl and apiKey are required" });
      return;
    }
    dependencies.llmClient.updateConfig(String(apiUrl), String(apiKey), model ? String(model) : undefined);

    // Persist to settings.toml
    try {
      const { saveLlmConfig } = await import("../../config/settings.js");
      await saveLlmConfig(dependencies.settings.settingsFilePath, {
        llmApiUrl: String(apiUrl),
        llmApiKey: String(apiKey),
        ...(model ? { llmModel: String(model) } : {}),
      });
    } catch {
      dependencies.logger.debug("failed to persist LLM config");
    }

    res.json(dependencies.llmClient.getConfig());
  });

  // Autostart management
  app.get("/api/autostart", async (_req: Request, res: Response) => {
    try {
      const { getAutostartStatus } = await import("../../autostart/index.js");
      const status = await getAutostartStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/autostart", async (req: Request, res: Response) => {
    try {
      const { action, webPort } = req.body;
      const { enableAutostart, disableAutostart, getAutostartStatus } = await import("../../autostart/index.js");

      if (action === "enable") {
        await enableAutostart({ enabled: true, webPort: webPort ? Number(webPort) : dependencies.runtime.webPort });
        res.json({ success: true, message: "Autostart enabled" });
      } else if (action === "disable") {
        await disableAutostart();
        res.json({ success: true, message: "Autostart disabled" });
      } else {
        res.status(400).json({ error: "Invalid action. Must be 'enable' or 'disable'." });
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
