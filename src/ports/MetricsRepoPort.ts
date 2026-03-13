import type { Metrics } from "../domain/entities/Metrics.js";
import type { TrendingRepo } from "../domain/entities/TrendingRepo.js";

/**
 * Port (interface) for persisting and querying metrics.
 * Implemented by adapters (e.g. Prisma); used by use cases. No implementation here.
 */
export interface MetricsRepoPort {
  saveMetrics(data: Metrics): Promise<void>;
  getMetrics(owner: string, repo: string): Promise<Metrics | null>;
  getTrending(language?: string): Promise<TrendingRepo[]>;
}
