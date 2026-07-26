/**
 * Append-only point-in-time snapshot of a repo's raw metadata.
 * Written on every enrichment run so decay/velocity can later be
 * computed from real deltas instead of a single-point heuristic.
 */
export interface RepoSnapshot {
  fullName: string;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: Date;
  releasedAt: Date | null;
  releaseTag: string | null;
}
