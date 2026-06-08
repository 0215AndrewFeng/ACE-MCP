import express, { type Express } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerAdminRoutes } from "./routes/adminRoutes.js";
import { registerIndexRoutes } from "./routes/indexRoutes.js";
import { registerMetaRoutes } from "./routes/metaRoutes.js";
import { registerQaRoutes } from "./routes/qaRoutes.js";
import { registerSearchRoutes } from "./routes/searchRoutes.js";
import { registerSummaryRoutes } from "./routes/summaryRoutes.js";
import type { WebAppDependencies, WebAppHandle } from "./types.js";

export type { WebAppDependencies, WebAppHandle } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startWebApp(port: number, dependencies: WebAppDependencies): Promise<WebAppHandle> {
  const app: Express = express();
  app.use(express.json());

  // Static files with cache control to ensure fresh content during development
  const staticPath = path.join(__dirname, "static");
  app.use("/static", express.static(staticPath, {
    etag: true,
    maxAge: 0, // No caching for development
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
    },
  }));

  registerMetaRoutes(app, dependencies);
  registerIndexRoutes(app, dependencies);
  registerAdminRoutes(app, dependencies);
  registerSearchRoutes(app, dependencies);
  registerSummaryRoutes(app, dependencies);
  registerQaRoutes(app, dependencies);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const listeningPort = typeof address === "object" && address !== null && "port" in address ? address.port : port;
      dependencies.logger.info("web debug panel started", { port: listeningPort });
      resolve({
        close: () => new Promise<void>((res, rej) => server.close((err) => err ? rej(err) : res())),
        port: listeningPort,
      });
    });
    server.on("error", reject);
  });
}
