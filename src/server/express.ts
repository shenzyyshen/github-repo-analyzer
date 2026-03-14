import express, { type Request, type Response, type NextFunction } from "express";
import type { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import type { GetTrending } from "../domain/usecases/GetTrending.js";
import type { MetricsRepoPort } from "../ports/MetricsRepoPort.js";

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function createExpressApp(
  analyzeRepo: AnalyzeRepo,
  getTrending: GetTrending,
  metricsRepoPort: MetricsRepoPort
) {
  const app = express();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", ts: new Date().toISOString() });
  });

  app.post(
    "/repos/:owner/:repo/analyze",
    asyncRoute(async (req, res) => {
      const { owner, repo } = req.params;
      const deep = req.body?.deep;
      if (deep !== undefined && typeof deep !== "boolean") {
        res.status(400).json({ error: "invalid_request", message: "`deep` must be boolean" });
        return;
      }

      const result = await analyzeRepo.execute(owner, repo, deep);
      res.json(result);
    })
  );

  app.get(
    "/repos/:owner/:repo",
    asyncRoute(async (req, res) => {
      const { owner, repo } = req.params;
      const metrics = await metricsRepoPort.getMetrics(owner, repo);
      if (!metrics) {
        res.status(404).json({ error: "not_found", message: "Metrics not found" });
        return;
      }
      res.json(metrics);
    })
  );

  app.get(
    "/trending/:language?",
    asyncRoute(async (req, res) => {
      const language = req.params.language;
      const results = await getTrending.execute(language);
      res.json(results);
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "internal_error", message });
  });

  return app;
}
