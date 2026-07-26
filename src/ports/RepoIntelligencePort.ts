import type { RepoSnapshot } from "../domain/entities/RepoSnapshot.js";
import type { RepoHealthScoreRecord } from "../domain/entities/RepoHealthScoreRecord.js";

/**
 * Port (interface) for persisting the intelligence-pipeline data that
 * decay, velocity, and trend detection depend on. Implemented by adapters
 * (e.g. Prisma); used by use cases. No implementation here.
 */
export interface RepoIntelligencePort {
  saveSnapshot(data: RepoSnapshot): Promise<void>;
  saveHealthScore(data: RepoHealthScoreRecord): Promise<void>;
}
