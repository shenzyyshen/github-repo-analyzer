import type { Metrics } from "../entities/Metrics.js";
import type { SearchResult } from "../entities/SearchResult.js";
import type { AnalyzeRepo } from "./AnalyzeRepo.js";
import type { RepoApiPort, RepoReleaseInfo, RepoRootEntry } from "../../ports/RepoApiPort.js";
import { buildRetrievalQueries, type ParsedIntent, type SearchInput } from "./ParseIntent.js";
import { daysSince, normalizeText, tokenizeRepo, unique } from "../shared/pipelineUtils.js";
import { PRESELECT } from "../../config/thresholds.js";

export type EnrichedRepo = {
  search: SearchResult;
  metrics: Metrics | null;
  readme: string | null;
  rootContents: RepoRootEntry[];
  latestRelease: RepoReleaseInfo | null;
  analysisError: string | null;
};

export type DiscoverReposOptions = {
  top: number;
  random?: boolean;
};

export type DiscoverReposResult = {
  stage1Raw: SearchResult[];
  enriched: EnrichedRepo[];
};

function buildGitHubQuery(search: SearchInput): string {
  const parts: string[] = [search.query];
  if (search.language) parts.push(`language:${search.language}`);
  if (search.minStars > 0) parts.push(`stars:>${search.minStars}`);
  if (search.since) parts.push(`pushed:>${search.since}`);
  if (search.license) parts.push(`license:${search.license}`);
  return parts.join(" ");
}

function preselectCandidates(
  results: SearchResult[],
  intent: ParsedIntent,
  top: number,
  random: boolean
): SearchResult[] {
  if (random) {
    const copy = [...results];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.min(top * 4, copy.length));
  }

  const candidatePoolSize = Math.min(Math.max(top * PRESELECT.poolMultiplier, PRESELECT.poolMin), PRESELECT.poolCap, results.length);
  return results
    .map((repo) => {
      const tokens = tokenizeRepo(repo, null);
      const terms = unique([
        ...intent.purposeTerms,
        ...intent.concepts,
        ...intent.displayTerms.flatMap((term) => normalizeText(term)),
      ]);
      const termMatches = terms.filter((term) => tokens.has(term)).length;
      const languageBonus =
        intent.language && repo.language && intent.language.toLowerCase() === repo.language.toLowerCase() ? 2 : 0;
      const starsBonus = PRESELECT.starBonuses.find((b) => repo.stars >= b.minStars)?.bonus ?? 0;
      const activityBonus = daysSince(repo.pushedAt) <= PRESELECT.activityBonus.recentDays ? PRESELECT.activityBonus.recentBonus : daysSince(repo.pushedAt) <= PRESELECT.activityBonus.activeDays ? PRESELECT.activityBonus.activeBonus : 0;
      return { repo, score: termMatches * PRESELECT.termMatchWeight + languageBonus + starsBonus + activityBonus };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, candidatePoolSize)
    .map((entry) => entry.repo);
}

/**
 * Use case: Stage 1 of the staged search pipeline — cast a wide net across
 * multiple query formulations, dedupe, narrow to a bounded candidate pool,
 * then enrich each candidate with README/root-contents/release/metrics so
 * later stages (quality gates, scoring) have what they need.
 */
export class DiscoverRepos {
  constructor(
    private readonly repoApiPort: RepoApiPort,
    private readonly analyzeRepo: AnalyzeRepo
  ) {}

  async execute(
    intent: ParsedIntent,
    search: SearchInput,
    options: DiscoverReposOptions
  ): Promise<DiscoverReposResult> {
    const queries = buildRetrievalQueries(intent, search.query);
    const merged = new Map<string, SearchResult>();

    for (const query of queries) {
      const batch = await this.repoApiPort.searchRepos(buildGitHubQuery({ ...search, query }), search.sort, 100);
      for (const repo of batch) {
        if (!merged.has(repo.fullName)) merged.set(repo.fullName, repo);
        if (merged.size >= 200) break;
      }
      if (merged.size >= 200) break;
    }

    const stage1Raw = [...merged.values()];
    const candidates = preselectCandidates(stage1Raw, intent, options.top, Boolean(options.random));
    const enriched = await Promise.all(candidates.map((repo) => this.enrichRepo(repo)));

    return { stage1Raw, enriched };
  }

  private async enrichRepo(search: SearchResult): Promise<EnrichedRepo> {
    const [metrics, readme, rootContents, latestRelease] = await Promise.allSettled([
      this.analyzeRepo.execute(search.owner, search.name, false),
      this.repoApiPort.getReadme(search.owner, search.name),
      this.repoApiPort.getRootContents(search.owner, search.name),
      this.repoApiPort.getLatestRelease(search.owner, search.name),
    ]);

    return {
      search,
      metrics: metrics.status === "fulfilled" ? metrics.value : null,
      readme: readme.status === "fulfilled" ? readme.value : null,
      rootContents: rootContents.status === "fulfilled" ? rootContents.value : [],
      latestRelease: latestRelease.status === "fulfilled" ? latestRelease.value : null,
      analysisError: metrics.status === "rejected" ? String(metrics.reason) : null,
    };
  }
}
