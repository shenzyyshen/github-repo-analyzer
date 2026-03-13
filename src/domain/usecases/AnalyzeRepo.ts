import type { Metrics } from "../entities/Metrics.js";
import type { RepoApiPort } from "../../ports/RepoApiPort.js";
import type { MetricsRepoPort } from "../../ports/MetricsRepoPort.js";

/**
 * Use case: analyze a GitHub repo and persist metrics.
 * Depends only on port interfaces (injected in constructor); no adapter or framework imports.
 */
export class AnalyzeRepo {
  constructor(
    private readonly repoApiPort: RepoApiPort,
    private readonly metricsRepoPort: MetricsRepoPort
  ) {}

  /**
   * Fetches repo + languages (and optionally issue count), computes star growth, saves and returns Metrics.
   * Implementation in Phase 5.
   */
  async execute(owner: string, repo: string, deep?: boolean): Promise<Metrics> {
    throw new Error("not implemented");
  }
}
