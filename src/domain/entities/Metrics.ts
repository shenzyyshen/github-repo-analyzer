/**
 * Snapshot of analyzed metrics for a repo (stored in DB, returned by analyze endpoint).
 * starGrowth24h is a display string, e.g. "+142 (0.8%)" or "+N/A (first analysis)".
 */
export interface Metrics {
  repoOwner: string;
  repoName: string;
  stars: number;
  starGrowth24h: string;
  languages: Record<string, number>;
  openIssues: number;
  contributors: number;
  lastCommit: Date;
  analyzedAt: Date;
}
