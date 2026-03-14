import type { TrendingRepo } from "../entities/TrendingRepo.js";
import type { MetricsRepoPort } from "../../ports/MetricsRepoPort.js";

/**
 * Use case: get trending repos (optionally filtered by language).
 * Delegates to the metrics port; no business logic beyond that.
 */
export class GetTrending {
  constructor(private readonly metricsRepoPort: MetricsRepoPort) {}

  /**
   * Returns repos analyzed in the last 24h, ordered by stars, optionally by primary language.
   * Implementation in Phase 5.
   */
  async execute(language?: string): Promise<TrendingRepo[]> {
    return this.metricsRepoPort.getTrending(language);
  }
}
