import type { Metrics } from "../entities/Metrics.js";
import type { SearchResult } from "../entities/SearchResult.js";
import type { RepoReleaseInfo, RepoRootEntry } from "../../ports/RepoApiPort.js";
import type { RepoIntelligencePort } from "../../ports/RepoIntelligencePort.js";
import type { EnrichedRepo } from "./DiscoverRepos.js";
import type { ParsedIntent } from "./ParseIntent.js";
import type {
  ArtifactType,
  ConfidenceLabel,
  DecayLabel,
  DependencyHealth,
  IntentClassification,
  OwnerTier,
} from "../entities/IntentClassification.js";
import {
  clamp,
  daysSince,
  domainFreshnessThresholds,
  keywordOverlap,
  normalizeText,
  ownerTierFor,
  ownerTierScore,
  unique,
} from "../shared/pipelineUtils.js";
import {
  CONFIDENCE_THRESHOLDS,
  FRESHNESS_COMPOSITE_WEIGHTS,
  FRESHNESS_OVERRIDE_DELTA,
  FRESHNESS_PUSH_SCORES,
  FRESHNESS_RELEASE_SCORES,
  HEALTH_DEPENDENCY_SCORES,
  HEALTH_SCORE_FLOOR,
  HEALTH_WEIGHTS,
  MAINTENANCE_SIGNALS,
  PROMPT_FIT_THRESHOLDS,
  PROMPT_FIT_WEIGHTS,
  RANKING_WEIGHTS,
  README_LENGTH_TARGET,
  README_QUALITY_WEIGHTS,
  STARS_VELOCITY_DIVISOR,
} from "../../config/thresholds.js";

type PromptFitBreakdown = {
  score: number;
  nameMatches: number;
  descriptionMatches: number;
  readmeMatches: number;
  topicMatches: number;
  languageMatched: boolean;
  artifactMatched: boolean;
};

type RepoHealthBreakdown = {
  readmeQuality: number;
  starsVelocity: number;
  dependencyFreshness: number;
  maintenanceQuality: number;
  ownerQuality: number;
};

type WeightedScoreBreakdown = {
  promptFit: number;
  health: number;
  freshness: number;
  ownerTier: number;
  stars: number;
  maintenance: number;
};

export type RankedRepo = {
  repo: SearchResult;
  metrics: Metrics | null;
  readme: string | null;
  latestRelease: RepoReleaseInfo | null;
  classification: IntentClassification;
  ownerTier: OwnerTier;
  dependencyHealth: DependencyHealth;
  decay: DecayLabel;
  confidence: ConfidenceLabel;
  artifactType: ArtifactType;
  promptFit: number;
  freshness: number;
  healthScore: number;
  finalScore: number;
  whyThisRepo: string;
  note: string | null;
  alternativesNote: string | null;
  breakdown: {
    promptFit: PromptFitBreakdown;
    health: RepoHealthBreakdown;
    ranking: WeightedScoreBreakdown;
  };
};

const EMPTY_INTENT: ParsedIntent = {
  language: null,
  since: null,
  license: null,
  maturitySignals: [],
  concepts: [],
  purposeTerms: [],
  boostTerms: [],
  displayTerms: [],
  normalizedQuery: "",
  confidence: 0,
};

function inferRepoArtifactType(repo: SearchResult, readme: string | null, rootContents: RepoRootEntry[]): ArtifactType {
  const text = [
    repo.fullName,
    repo.description ?? "",
    readme ?? "",
    ...rootContents.map((entry) => entry.name),
    ...(repo.topics ?? []),
  ].join(" ").toLowerCase();

  if (/\b(cli|command line|terminal)\b/.test(text)) return "cli";
  if (/\b(framework|platform|orchestrator)\b/.test(text)) return "framework";
  if (/\b(dataset|benchmark)\b/.test(text)) return "dataset";
  if (/\b(boilerplate|starter|template)\b/.test(text)) return "boilerplate";
  if (/\b(awesome|curated|tips|guide|tutorial)\b/.test(text)) return "tips-content";
  if (/\b(library|sdk|package|module)\b/.test(text)) return "library";
  return "tool";
}

function promptFitBreakdown(
  intent: ParsedIntent,
  classification: IntentClassification,
  repo: SearchResult,
  readme: string | null,
  rootContents: RepoRootEntry[]
): PromptFitBreakdown {
  const terms = unique([
    ...intent.purposeTerms,
    ...intent.concepts,
    ...intent.displayTerms.flatMap((term) => normalizeText(term)),
  ]);
  const nameTokens = new Set(normalizeText(repo.name));
  const descriptionTokens = new Set(normalizeText(repo.description ?? ""));
  const readmeTokens = new Set(normalizeText(readme ?? ""));
  const topicTokens = new Set((repo.topics ?? []).flatMap((topic) => normalizeText(topic)));

  const nameMatches = terms.filter((term) => nameTokens.has(term)).length;
  const descriptionMatches = terms.filter((term) => descriptionTokens.has(term)).length;
  const readmeMatches = terms.filter((term) => readmeTokens.has(term)).length;
  const topicMatches = terms.filter((term) => topicTokens.has(term)).length;
  const languageMatched =
    Boolean(intent.language && repo.language && intent.language.toLowerCase() === repo.language.toLowerCase());
  const repoArtifact = inferRepoArtifactType(repo, readme, rootContents);
  const artifactMatched = repoArtifact === classification.artifactType || classification.artifactType === "tool";

  const score = clamp(
    nameMatches * PROMPT_FIT_WEIGHTS.name +
      descriptionMatches * PROMPT_FIT_WEIGHTS.description +
      readmeMatches * PROMPT_FIT_WEIGHTS.readme +
      topicMatches * PROMPT_FIT_WEIGHTS.topics +
      (languageMatched ? PROMPT_FIT_WEIGHTS.language : 0) +
      (artifactMatched ? PROMPT_FIT_WEIGHTS.artifact : 0),
    0,
    1
  );

  return {
    score,
    nameMatches,
    descriptionMatches,
    readmeMatches,
    topicMatches,
    languageMatched,
    artifactMatched,
  };
}

function readmeQualityScore(readme: string | null, overlap: number): number {
  if (!readme) return 0;
  const lowered = readme.toLowerCase();
  const lengthScore = Math.min(readme.length / README_LENGTH_TARGET, 1);
  const installScore = /\binstall|setup|get started|quickstart\b/.test(lowered) ? 1 : 0;
  const usageScore = /\busage|example|examples\b/.test(lowered) || /```/.test(readme) ? 1 : 0;
  return clamp(
    lengthScore * README_QUALITY_WEIGHTS.length +
      overlap * README_QUALITY_WEIGHTS.overlap +
      installScore * README_QUALITY_WEIGHTS.install +
      usageScore * README_QUALITY_WEIGHTS.usage,
    0,
    1
  );
}

function freshnessScore(
  classification: IntentClassification,
  repo: SearchResult,
  latestRelease: RepoReleaseInfo | null,
  readme: string | null
): number {
  const thresholds = domainFreshnessThresholds(classification.domainSpeed);
  const pushDays = daysSince(repo.pushedAt);
  const releaseDays = daysSince(latestRelease?.publishedAt ?? null);
  const terminologyScore =
    classification.domainSpeed === "fast" && readme
      ? Number(keywordOverlap({ ...EMPTY_INTENT, purposeTerms: normalizeText(readme).slice(0, 0), concepts: [], displayTerms: [], normalizedQuery: "", confidence: 1, language: null, since: null, license: null, maturitySignals: [], boostTerms: [] }, repo, readme) >= 0)
      : 0;

  const pushScore =
    pushDays <= thresholds.soft
      ? FRESHNESS_PUSH_SCORES.soft
      : pushDays <= thresholds.hard
        ? FRESHNESS_PUSH_SCORES.hard
        : pushDays <= thresholds.disqualify
          ? FRESHNESS_PUSH_SCORES.disqualify
          : FRESHNESS_PUSH_SCORES.expired;
  const releaseScore =
    releaseDays <= thresholds.soft
      ? FRESHNESS_RELEASE_SCORES.soft
      : releaseDays <= thresholds.hard
        ? FRESHNESS_RELEASE_SCORES.hard
        : releaseDays <= thresholds.disqualify
          ? FRESHNESS_RELEASE_SCORES.disqualify
          : latestRelease
            ? FRESHNESS_RELEASE_SCORES.expiredWithRelease
            : FRESHNESS_RELEASE_SCORES.expiredNoRelease;

  return clamp(
    pushScore * FRESHNESS_COMPOSITE_WEIGHTS.push +
      releaseScore * FRESHNESS_COMPOSITE_WEIGHTS.release +
      terminologyScore * FRESHNESS_COMPOSITE_WEIGHTS.terminology,
    0,
    1
  );
}

function dependencyHealthFor(repo: SearchResult, readme: string | null, rootContents: RepoRootEntry[]): DependencyHealth {
  const lowered = `${repo.description ?? ""}\n${readme ?? ""}`.toLowerCase();
  const names = new Set(rootContents.map((entry) => entry.name.toLowerCase()));
  if (/\bdeprecated\b|\bunmaintained\b|\babandoned\b/.test(lowered)) {
    return "Supply chain risk";
  }
  if (
    (names.has("package.json") && !names.has("package-lock.json") && !names.has("pnpm-lock.yaml") && !names.has("yarn.lock")) ||
    (names.has("requirements.txt") && !names.has("pyproject.toml"))
  ) {
    return "Minor risk";
  }
  return "Clean";
}

function healthBreakdown(
  repo: SearchResult,
  metrics: Metrics | null,
  readme: string | null,
  latestRelease: RepoReleaseInfo | null,
  ownerTier: OwnerTier,
  dependencyHealth: DependencyHealth,
  overlap: number
): RepoHealthBreakdown {
  const readmeQuality = readmeQualityScore(readme, overlap);
  const repoAgeMonths = Math.max(1, daysSince(repo.createdAt) / 30);
  const starsVelocity = clamp(repo.stars / repoAgeMonths / STARS_VELOCITY_DIVISOR, 0, 1);
  const dependencyFreshness = HEALTH_DEPENDENCY_SCORES[dependencyHealth];
  const ms = MAINTENANCE_SIGNALS;
  const maintenanceSignals = clamp(
    (daysSince(repo.pushedAt) <= ms.recentPushDays ? ms.scores.recentPush : daysSince(repo.pushedAt) <= ms.activePushDays ? ms.scores.activePush : 0) +
      (latestRelease && daysSince(latestRelease.publishedAt) <= ms.recentReleaseDays ? ms.scores.release : ms.scores.releaseAbsent) +
      (metrics && metrics.contributors >= ms.minContributorsGood ? ms.scores.contributorsGood : metrics && metrics.contributors >= ms.minContributorsOk ? ms.scores.contributorsOk : 0) +
      (metrics && metrics.openIssues <= ms.maxIssuesGood ? ms.scores.issuesGood : ms.scores.issuesAbsent),
    0,
    1
  );

  return {
    readmeQuality,
    starsVelocity,
    dependencyFreshness,
    maintenanceQuality: maintenanceSignals,
    ownerQuality: ownerTierScore(ownerTier),
  };
}

function repoHealthScore(breakdown: RepoHealthBreakdown): number {
  return Math.round(
    breakdown.readmeQuality * HEALTH_WEIGHTS.readmeQuality +
      breakdown.starsVelocity * HEALTH_WEIGHTS.starsVelocity +
      breakdown.dependencyFreshness * HEALTH_WEIGHTS.dependencyFreshness +
      breakdown.maintenanceQuality * HEALTH_WEIGHTS.maintenanceQuality +
      breakdown.ownerQuality * HEALTH_WEIGHTS.ownerQuality
  );
}

function decayLabelFor(
  classification: IntentClassification,
  repo: SearchResult,
  metrics: Metrics | null,
  latestRelease: RepoReleaseInfo | null,
  dependencyHealth: DependencyHealth
): DecayLabel {
  const thresholds = domainFreshnessThresholds(classification.domainSpeed);
  let softSignals = 0;
  if (daysSince(repo.pushedAt) > thresholds.soft) softSignals += 1;
  if (latestRelease && daysSince(latestRelease.publishedAt) > thresholds.hard) softSignals += 1;
  if (metrics && metrics.contributors <= 1) softSignals += 1;
  if (dependencyHealth === "Supply chain risk") softSignals += 2;
  if (daysSince(repo.pushedAt) > thresholds.disqualify) softSignals += 3;

  if (softSignals >= 4) return "Abandoned";
  if (softSignals >= 3) return "Fading";
  if (softSignals >= 1) return "Slowing";
  return "Healthy";
}

function rankingWeights(classification: IntentClassification): WeightedScoreBreakdown {
  const base: WeightedScoreBreakdown = { ...(classification.domainSpeed === "fast" ? RANKING_WEIGHTS.fast : RANKING_WEIGHTS.slow) };

  if (classification.freshnessOverride === "strict") {
    base.freshness += FRESHNESS_OVERRIDE_DELTA;
    base.stars = Math.max(0, base.stars - 0.1);
  } else if (classification.freshnessOverride === "relaxed") {
    base.freshness = Math.max(0, base.freshness - FRESHNESS_OVERRIDE_DELTA);
    base.maintenance += FRESHNESS_OVERRIDE_DELTA;
  }

  return base;
}

export function confidenceLabel(
  stageCounts: { stage3PromptFit: number },
  topScoreGap: number
): ConfidenceLabel {
  if (stageCounts.stage3PromptFit < CONFIDENCE_THRESHOLDS.medium.minStage3 || topScoreGap < CONFIDENCE_THRESHOLDS.medium.minGap) return "Low";
  if (stageCounts.stage3PromptFit < CONFIDENCE_THRESHOLDS.high.minStage3 || topScoreGap < CONFIDENCE_THRESHOLDS.high.minGap) return "Medium";
  return "High";
}

export type ScoreAndRankResult = {
  promptFitPassedCount: number;
  ranked: RankedRepo[];
};

/**
 * Use case: Stage 3-4 of the staged search pipeline — score each
 * quality-gated candidate against the prompt, compute health/freshness/
 * decay/dependency signals, combine into a domain-speed-weighted composite
 * score, and persist the intelligence data (snapshot + health score) each
 * ranked repo produces.
 */
export class ScoreAndRank {
  constructor(private readonly repoIntelligencePort: RepoIntelligencePort) {}

  async execute(
    candidates: EnrichedRepo[],
    classification: IntentClassification,
    intent: ParsedIntent
  ): Promise<ScoreAndRankResult> {
    const promptFitThreshold = PROMPT_FIT_THRESHOLDS[classification.specificity];
    const promptFitPassed = candidates
      .map((repo) => {
        const fit = promptFitBreakdown(intent, classification, repo.search, repo.readme, repo.rootContents);
        return { repo, fit };
      })
      .filter((entry) => entry.fit.score >= promptFitThreshold);

    const weights = rankingWeights(classification);
    const ranked = promptFitPassed
      .map(({ repo, fit }) => {
        const ownerTier = ownerTierFor(repo.search);
        const dependencyHealth = dependencyHealthFor(repo.search, repo.readme, repo.rootContents);
        const health = healthBreakdown(
          repo.search,
          repo.metrics,
          repo.readme,
          repo.latestRelease,
          ownerTier,
          dependencyHealth,
          keywordOverlap(intent, repo.search, repo.readme)
        );
        const healthScore = repoHealthScore(health);
        if (healthScore < HEALTH_SCORE_FLOOR) return null;

        const freshness = freshnessScore(classification, repo.search, repo.latestRelease, repo.readme);
        const decay = decayLabelFor(classification, repo.search, repo.metrics, repo.latestRelease, dependencyHealth);
        if (decay === "Abandoned") return null;

        const starsNormalized = clamp(Math.log10(Math.max(repo.search.stars, 1)) / 5, 0, 1);
        const maintenanceNormalized = health.maintenanceQuality;
        const finalScore = clamp(
          fit.score * weights.promptFit +
            (healthScore / 100) * weights.health +
            freshness * weights.freshness +
            ownerTierScore(ownerTier) * weights.ownerTier +
            starsNormalized * weights.stars +
            maintenanceNormalized * weights.maintenance,
          0,
          1
        );

        const confidence: ConfidenceLabel = "Medium";
        const noteParts: string[] = [];
        if (decay === "Slowing" || decay === "Fading") noteParts.push(`Decay: ${decay}`);
        if (dependencyHealth !== "Clean") noteParts.push(`Dependency health: ${dependencyHealth}`);
        if (repo.analysisError) noteParts.push("Some analysis signals were unavailable");

        return {
          repo: repo.search,
          metrics: repo.metrics,
          readme: repo.readme,
          latestRelease: repo.latestRelease,
          classification,
          ownerTier,
          dependencyHealth,
          decay,
          confidence,
          artifactType: inferRepoArtifactType(repo.search, repo.readme, repo.rootContents),
          promptFit: fit.score,
          freshness,
          healthScore,
          finalScore,
          whyThisRepo: [
            `Match: ${fit.score >= 0.75 ? "strong direct fit" : fit.score >= 0.5 ? "credible fit" : "broader but relevant fit"}`,
            `Freshness: ${daysSince(repo.latestRelease?.publishedAt ?? repo.search.pushedAt) <= 30 ? "recently active" : "still current for its domain"}`,
            `Owner: ${ownerTier}`,
            `Dependency health: ${dependencyHealth}`,
            `Prompt fit: ${Math.round(fit.score * 100)}%`,
          ].join(" | "),
          note: noteParts.length > 0 ? noteParts.join(" | ") : null,
          alternativesNote: null,
          breakdown: {
            promptFit: fit,
            health,
            ranking: weights,
          },
        } satisfies RankedRepo;
      })
      .filter(Boolean) as RankedRepo[];

    ranked.sort((a, b) => b.finalScore - a.finalScore);

    await Promise.all(ranked.map((result) => this.persistIntelligence(result)));

    return { promptFitPassedCount: promptFitPassed.length, ranked };
  }

  private async persistIntelligence(result: RankedRepo): Promise<void> {
    try {
      await Promise.all([
        this.repoIntelligencePort.saveSnapshot({
          fullName: result.repo.fullName,
          stars: result.repo.stars,
          forks: result.repo.forks,
          openIssues: result.metrics?.openIssues ?? 0,
          pushedAt: result.repo.pushedAt,
          releasedAt: result.latestRelease?.publishedAt ?? null,
          releaseTag: result.latestRelease?.tagName ?? null,
        }),
        this.repoIntelligencePort.saveHealthScore({
          fullName: result.repo.fullName,
          score: result.healthScore,
          decay: result.decay,
          readmeQuality: result.breakdown.health.readmeQuality,
          starsVelocity: result.breakdown.health.starsVelocity,
          dependencyFreshness: result.breakdown.health.dependencyFreshness,
          maintenanceQuality: result.breakdown.health.maintenanceQuality,
          ownerQuality: result.breakdown.health.ownerQuality,
        }),
      ]);
    } catch (err) {
      // Snapshot/health persistence is telemetry for future decay/trend detection —
      // a write failure must never break the search results the user is waiting on.
      console.error(`Failed to persist intelligence data for ${result.repo.fullName}:`, err);
    }
  }
}
