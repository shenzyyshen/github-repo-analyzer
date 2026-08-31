import type { Metrics } from "../entities/Metrics.js";
import type { RepoApiPort } from "../../ports/RepoApiPort.js";
import type { MetricsRepoPort } from "../../ports/MetricsRepoPort.js";
import type { RepoIntelligencePort } from "../../ports/RepoIntelligencePort.js";

/**
 * Use case: analyze a GitHub repo and persist metrics.
 * Depends only on port interfaces (injected in constructor); no adapter or framework imports.
 */
export class AnalyzeRepo {
  constructor(
    private readonly repoApiPort: RepoApiPort,
    private readonly metricsRepoPort: MetricsRepoPort,
    private readonly repoIntelligencePort: RepoIntelligencePort
  ) {}

  /**
   * Fetches repo + languages (and optionally issue count), computes star growth, saves and returns Metrics.
   * Implementation in Phase 5.
   */
  async execute(owner: string, repo: string, deep?: boolean): Promise<Metrics> {
    const [repoData, languages, previous, contributors] = await Promise.all([
      this.repoApiPort.getRepo(owner, repo),
      this.repoApiPort.getLanguages(owner, repo),
      this.metricsRepoPort.getMetrics(owner, repo),
      this.repoApiPort.getContributors(owner, repo),
    ]);

    const openIssues = deep
      ? await this.repoApiPort.getIssues(owner, repo)
      : repoData.openIssues;

    const analyzedAt = new Date();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    const hasRecentPrevious =
      previous &&
      analyzedAt.getTime() - previous.analyzedAt.getTime() <= twentyFourHoursMs;

    let starGrowth24h = "+N/A (first analysis)";
    if (hasRecentPrevious && previous) {
      const delta = repoData.stars - previous.stars;
      const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
      const absDelta = Math.abs(delta);
      const percent =
        previous.stars > 0 ? (absDelta / previous.stars) * 100 : 0;
      starGrowth24h = `${sign}${absDelta} (${sign}${percent.toFixed(2)}%)`;
    }

    const metrics: Metrics = {
      repoOwner: repoData.owner,
      repoName: repoData.name,
      stars: repoData.stars,
      starGrowth24h,
      languages,
      openIssues,
      contributors,
      lastCommit: repoData.pushedAt,
      analyzedAt,
    };

    await this.metricsRepoPort.saveMetrics(metrics);

    // Best-effort — this is telemetry for future decay/trend detection, not
    // core to what the caller asked for, so a write failure here must never
    // fail the analysis itself. Same pattern as ScoreAndRank's snapshot
    // writes. Release fields are left null: this call path doesn't fetch
    // latest-release data (only the staged-search pipeline does), and
    // guessing would be worse than an honest gap.
    try {
      await this.repoIntelligencePort.saveSnapshot({
        fullName: repoData.fullName,
        stars: repoData.stars,
        forks: repoData.forks,
        openIssues,
        pushedAt: repoData.pushedAt,
        releasedAt: null,
        releaseTag: null,
      });
    } catch (err) {
      console.error(`Failed to persist intelligence snapshot for ${repoData.fullName}:`, err);
    }

    return metrics;
  }
}
