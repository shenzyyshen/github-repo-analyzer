/**
 * Append-only scored health record, written after a full enrichment run.
 * Component subscores are stored, not just the total, so the explanation
 * layer and future trend detection can use the breakdown.
 */
export interface RepoHealthScoreRecord {
  fullName: string;
  score: number;
  decay: string;
  readmeQuality: number;
  starsVelocity: number;
  dependencyFreshness: number;
  maintenanceQuality: number;
  ownerQuality: number;
}
