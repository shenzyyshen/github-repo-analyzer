import chalk from "chalk";
import type { Metrics } from "../domain/entities/Metrics.js";
import type { SearchResult } from "../domain/entities/SearchResult.js";
import type { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import type { RepoApiPort, RepoReleaseInfo, RepoRootEntry } from "../ports/RepoApiPort.js";
import type { RepoIntelligencePort } from "../ports/RepoIntelligencePort.js";
import {
  inferFilters,
  type ParsedIntent,
  type SearchInput,
} from "../domain/usecases/ParseIntent.js";
import { DiscoverRepos, type EnrichedRepo } from "../domain/usecases/DiscoverRepos.js";
import { clamp, daysSince, normalizeText, tokenizeRepo, unique } from "../domain/shared/pipelineUtils.js";
import {
  CONFIDENCE_THRESHOLDS,
  DOMAIN_SPEED_TERMS,
  FRESHNESS_COMPOSITE_WEIGHTS,
  FRESHNESS_OVERRIDE_DELTA,
  FRESHNESS_PUSH_SCORES,
  FRESHNESS_RELEASE_SCORES,
  FRESHNESS_THRESHOLDS,
  HEALTH_DEPENDENCY_SCORES,
  HEALTH_SCORE_FLOOR,
  HEALTH_WEIGHTS,
  KNOWN_ELITE_OWNERS,
  MAINTENANCE_SIGNALS,
  OWNER_TIER_SCORES,
  OWNER_TIER_THRESHOLDS,
  PROMPT_FIT_THRESHOLDS,
  PROMPT_FIT_WEIGHTS,
  RANKING_WEIGHTS,
  README_LENGTH_TARGET,
  README_QUALITY_WEIGHTS,
  STAGE2,
  STAR_FLOOR_BASE,
  STAR_FLOOR_ELITE,
  STAR_FLOOR_STRONG,
  STARS_VELOCITY_DIVISOR,
} from "../config/thresholds.js";

export type IntentMode = "best_match" | "best_shortlist" | "watch";
export type DomainSpeed = "fast" | "medium" | "slow";
export type ArtifactType =
  | "library"
  | "framework"
  | "cli"
  | "tips-content"
  | "dataset"
  | "boilerplate"
  | "tool";
export type FreshnessOverride = "strict" | "relaxed" | "none";
export type OwnerPreference = "company-backed" | "community" | "any";
export type Specificity = "narrow" | "broad";
export type OwnerTier = "Elite" | "Strong" | "Promising" | "Weak";
export type DecayLabel = "Healthy" | "Slowing" | "Fading" | "Abandoned";
export type DependencyHealth = "Clean" | "Minor risk" | "Supply chain risk";
export type ConfidenceLabel = "High" | "Medium" | "Low";

export type StagedSearchOptions = {
  requestedMode?: IntentMode;
  top: number;
  random?: boolean;
  explain?: boolean;
};

export type IntentClassification = {
  artifactType: ArtifactType;
  domainSpeed: DomainSpeed;
  specificity: Specificity;
  intentMode: IntentMode;
  freshnessOverride: FreshnessOverride;
  ownerPreference: OwnerPreference;
  confidence: number;
};

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

export type StagedSearchResult = {
  query: string;
  filters: SearchInput;
  appliedFilters: string[];
  intent: ParsedIntent;
  classification: IntentClassification;
  stageCounts: {
    stage1Raw: number;
    stage2QualityFloor: number;
    stage3PromptFit: number;
    stage4Ranked: number;
    stage5Returned: number;
  };
  results: RankedRepo[];
};



function inferArtifactType(query: string, intent: ParsedIntent): ArtifactType {
  const text = [query, intent.normalizedQuery, ...intent.displayTerms, ...intent.purposeTerms].join(" ").toLowerCase();
  if (/\b(cli|terminal|command)\b/.test(text)) return "cli";
  if (/\b(framework|platform|orchestrator)\b/.test(text)) return "framework";
  if (/\b(dataset|benchmark)\b/.test(text)) return "dataset";
  if (/\b(boilerplate|starter|template)\b/.test(text)) return "boilerplate";
  if (/\b(tips|awesome|curated|guide|tutorial)\b/.test(text)) return "tips-content";
  if (/\b(library|sdk|package|module)\b/.test(text)) return "library";
  return "tool";
}

function classifyIntent(
  originalQuery: string,
  intent: ParsedIntent,
  requestedMode: IntentMode | undefined
): IntentClassification {
  const text = originalQuery.toLowerCase();
  const domainSpeed: DomainSpeed = DOMAIN_SPEED_TERMS.fast.test(text)
    ? "fast"
    : DOMAIN_SPEED_TERMS.slow.test(text)
      ? "slow"
      : "medium";
  const specificity: Specificity =
    intent.purposeTerms.length >= 4 || Boolean(intent.language) || intent.displayTerms.length >= 2
      ? "narrow"
      : "broad";
  const intentMode: IntentMode = requestedMode
    ?? (/\b(compare|options|shortlist|few choices|tradeoff)\b/.test(text) ? "best_shortlist" : "best_match");
  const freshnessOverride: FreshnessOverride = /\b(latest|new|current|today|2025|2026|recent)\b/.test(text)
    ? "strict"
    : /\b(stable|production|battle-tested|mature)\b/.test(text)
      ? "relaxed"
      : "none";
  const ownerPreference: OwnerPreference = /\b(company|official|vendor-backed)\b/.test(text)
    ? "company-backed"
    : /\b(community|independent)\b/.test(text)
      ? "community"
      : "any";

  return {
    artifactType: inferArtifactType(originalQuery, intent),
    domainSpeed,
    specificity,
    intentMode,
    freshnessOverride,
    ownerPreference,
    confidence: clamp(intent.confidence, 0, 1),
  };
}

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

function ownerTierFor(repo: SearchResult): OwnerTier {
  const owner = repo.owner.toLowerCase();
  if (KNOWN_ELITE_OWNERS.has(owner) || repo.stars >= OWNER_TIER_THRESHOLDS.elite.stars || repo.forks >= OWNER_TIER_THRESHOLDS.elite.forks) {
    return "Elite";
  }
  if (repo.stars >= OWNER_TIER_THRESHOLDS.strong.stars || repo.forks >= OWNER_TIER_THRESHOLDS.strong.forks) {
    return "Strong";
  }
  if (repo.stars >= OWNER_TIER_THRESHOLDS.promising.stars || repo.forks >= OWNER_TIER_THRESHOLDS.promising.forks || daysSince(repo.pushedAt) <= OWNER_TIER_THRESHOLDS.promising.activeDays) {
    return "Promising";
  }
  return "Weak";
}

function ownerTierScore(tier: OwnerTier): number {
  return OWNER_TIER_SCORES[tier];
}

function domainFreshnessThresholds(speed: DomainSpeed): { soft: number; hard: number; disqualify: number } {
  return FRESHNESS_THRESHOLDS[speed];
}

function minimumStarsFor(speed: DomainSpeed, ownerTier: OwnerTier): number {
  const base = STAR_FLOOR_BASE[speed];
  if (ownerTier === "Elite") return Math.max(STAR_FLOOR_ELITE.min, Math.floor(base / STAR_FLOOR_ELITE.divisor));
  if (ownerTier === "Strong") return Math.max(STAR_FLOOR_STRONG.min, Math.floor(base * STAR_FLOOR_STRONG.multiplier));
  return base;
}

function keywordOverlap(intent: ParsedIntent, repo: SearchResult, readme: string | null): number {
  const tokens = tokenizeRepo(repo, readme);
  const terms = unique([
    ...intent.purposeTerms,
    ...intent.concepts,
    ...intent.displayTerms.flatMap((term) => normalizeText(term)),
  ]);
  if (terms.length === 0) return 0;
  const matches = terms.filter((term) => tokens.has(term)).length;
  return matches / terms.length;
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

function confidenceLabel(stageCounts: StagedSearchResult["stageCounts"], topScoreGap: number): ConfidenceLabel {
  if (stageCounts.stage3PromptFit < CONFIDENCE_THRESHOLDS.medium.minStage3 || topScoreGap < CONFIDENCE_THRESHOLDS.medium.minGap) return "Low";
  if (stageCounts.stage3PromptFit < CONFIDENCE_THRESHOLDS.high.minStage3 || topScoreGap < CONFIDENCE_THRESHOLDS.high.minGap) return "Medium";
  return "High";
}

function stage2GateReason(
  repo: EnrichedRepo,
  classification: IntentClassification,
  intent: ParsedIntent,
  ownerTier: OwnerTier
): string | null {
  const overlap = keywordOverlap(intent, repo.search, repo.readme);
  const thresholds = domainFreshnessThresholds(classification.domainSpeed);
  const readmeLength = repo.readme?.trim().length ?? 0;
  const eliteReadmeExemption = ownerTier === "Elite" && repo.search.stars >= STAGE2.eliteReadmeExemptionMinStars;

  if (repo.search.archived) return "archived";
  if (repo.search.isFork) return "fork";
  if (!repo.readme && !eliteReadmeExemption) return "missing README";
  if (readmeLength < STAGE2.minReadmeLength && !eliteReadmeExemption) return "README too thin";
  if (overlap < STAGE2.minKeywordOverlap) return "README/prompt overlap too weak";
  if (daysSince(repo.search.pushedAt) > thresholds.disqualify) return "stale for domain";
  if (repo.search.stars < minimumStarsFor(classification.domainSpeed, ownerTier)) return "below star floor";
  return null;
}

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

async function persistIntelligence(
  repoIntelligencePort: RepoIntelligencePort,
  result: RankedRepo
): Promise<void> {
  try {
    await Promise.all([
      repoIntelligencePort.saveSnapshot({
        fullName: result.repo.fullName,
        stars: result.repo.stars,
        forks: result.repo.forks,
        openIssues: result.metrics?.openIssues ?? 0,
        pushedAt: result.repo.pushedAt,
        releasedAt: result.latestRelease?.publishedAt ?? null,
        releaseTag: result.latestRelease?.tagName ?? null,
      }),
      repoIntelligencePort.saveHealthScore({
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

export async function runStagedSearch(
  repoApiPort: RepoApiPort,
  analyzeRepo: AnalyzeRepo,
  repoIntelligencePort: RepoIntelligencePort,
  originalQuery: string,
  baseSearch: SearchInput,
  options: StagedSearchOptions
): Promise<StagedSearchResult> {
  const { search, applied, intent } = inferFilters(originalQuery, baseSearch);
  const classification = classifyIntent(originalQuery, intent, options.requestedMode);

  const discoverRepos = new DiscoverRepos(repoApiPort, analyzeRepo);
  const { stage1Raw, enriched } = await discoverRepos.execute(intent, search, {
    top: options.top,
    random: options.random,
  });

  const qualityPassed = enriched.filter((repo) => {
    const ownerTier = ownerTierFor(repo.search);
    return !stage2GateReason(repo, classification, intent, ownerTier);
  });

  const promptFitThreshold = PROMPT_FIT_THRESHOLDS[classification.specificity];
  const promptFitPassed = qualityPassed
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

  await Promise.all(ranked.map((result) => persistIntelligence(repoIntelligencePort, result)));

  const returnedCount = classification.intentMode === "best_match" ? 1 : options.top;
  const results = ranked.slice(0, returnedCount).map((result, index, arr) => {
    const gap = index === 0 && arr[1] ? result.finalScore - arr[1].finalScore : 0.1;
    const closeAlternatives = index === 0
      ? arr
          .slice(1, 4)
          .filter((candidate) => Math.abs(candidate.healthScore - result.healthScore) <= 15)
          .map((candidate) => `${candidate.repo.fullName} (${candidate.artifactType}, health ${candidate.healthScore})`)
      : [];

    return {
      ...result,
      confidence: confidenceLabel(
        {
          stage1Raw: stage1Raw.length,
          stage2QualityFloor: qualityPassed.length,
          stage3PromptFit: promptFitPassed.length,
          stage4Ranked: ranked.length,
          stage5Returned: Math.min(ranked.length, returnedCount),
        },
        gap
      ),
      alternativesNote:
        index === 0 && closeAlternatives.length > 0
          ? `Alternatives worth knowing: ${closeAlternatives.join("; ")}`
          : null,
    };
  });

  return {
    query: originalQuery,
    filters: search,
    appliedFilters: applied,
    intent,
    classification,
    stageCounts: {
      stage1Raw: stage1Raw.length,
      stage2QualityFloor: qualityPassed.length,
      stage3PromptFit: promptFitPassed.length,
      stage4Ranked: ranked.length,
      stage5Returned: results.length,
    },
    results,
  };
}

export function renderStagedSearch(result: StagedSearchResult, explain = false): string {
  const HR = chalk.dim("─".repeat(62));
  const DOT = chalk.dim("  ·  ");
  const pad = "       ";

  const colorHealth = (n: number) =>
    n >= 70 ? chalk.green(String(n)) : n >= 40 ? chalk.yellow(String(n)) : chalk.red(String(n));

  const colorDecay = (d: string) => {
    if (d === "Healthy") return chalk.green(d);
    if (d === "Slowing" || d === "Fading") return chalk.yellow(d);
    return chalk.red(d);
  };

  const colorConfidence = (c: string) => {
    if (c === "High") return chalk.green(c);
    if (c === "Low") return chalk.dim(c);
    return chalk.white(c);
  };

  const s = result.stageCounts;
  const pipeline = [s.stage1Raw, s.stage2QualityFloor, s.stage3PromptFit, s.stage4Ranked]
    .map(String)
    .join(chalk.dim(" → ")) + chalk.dim(" → ") + chalk.bold(String(s.stage5Returned));

  const lines: string[] = [
    "",
    `  ${chalk.bold.cyan("Repo Search")}  ${chalk.dim(result.classification.intentMode)}${DOT}${chalk.dim(result.classification.artifactType)}${DOT}${Math.round(result.classification.confidence * 100)}% confidence`,
    `  ${chalk.dim("Pipeline")}   ${pipeline}  ${chalk.dim("(raw → quality → fit → ranked → returned)")}`,
  ];

  if (result.appliedFilters.length > 0) {
    lines.push(`  ${chalk.dim("Filters")}    ${result.appliedFilters.join(DOT)}`);
  }

  lines.push(`\n  ${HR}`);

  if (result.results.length === 0) {
    lines.push(`\n  ${chalk.dim("No repos cleared the quality and prompt-fit thresholds.")}\n`);
    return `${lines.join("\n")}\n`;
  }

  result.results.forEach((entry, index) => {
    const isTop = index === 0;
    const rankMark = isTop ? chalk.yellow("★") : chalk.dim("◦");
    const nameStyled = isTop ? chalk.bold.white(entry.repo.fullName) : chalk.white(entry.repo.fullName);

    const lastPush = entry.repo.pushedAt.toISOString().slice(0, 10);
    const isStale = Date.now() - entry.repo.pushedAt.getTime() > 6 * 30 * 24 * 60 * 60 * 1000;
    const lastPushColored = isStale ? chalk.red(lastPush) : chalk.green(lastPush);

    lines.push("");
    lines.push(
      `  ${rankMark}  ${nameStyled}   ` +
      `${chalk.dim("health")} ${colorHealth(entry.healthScore)}  ${DOT.trim()}  ` +
      `${colorDecay(entry.decay)}  ${DOT.trim()}  ` +
      `${colorConfidence(entry.confidence)} confidence`
    );

    if (entry.repo.description) {
      lines.push(`${pad}${chalk.dim(entry.repo.description)}`);
    }

    lines.push("");
    lines.push(`${pad}${chalk.dim("Why")}  ${entry.whyThisRepo}`);
    lines.push(
      `${pad}${chalk.dim("Tier")}  ${entry.ownerTier}${DOT}` +
      `${chalk.dim("Type")}  ${entry.artifactType}${DOT}` +
      `${chalk.dim("Score")}  ${chalk.bold((entry.finalScore * 100).toFixed(1))}`
    );

    lines.push("");
    lines.push(
      `${pad}${chalk.yellow("★")} ${chalk.yellow(entry.repo.stars.toLocaleString())} stars${DOT}` +
      `Freshness ${Math.round(entry.freshness * 100)}%${DOT}` +
      `Last updated ${lastPushColored}`
    );

    if (entry.note) {
      lines.push(`${pad}${chalk.yellow("⚠")}  ${chalk.yellow(entry.note)}`);
    }
    if (entry.alternativesNote) {
      lines.push(`${pad}${chalk.dim(entry.alternativesNote)}`);
    }

    if (explain) {
      lines.push("");
      lines.push(
        `${pad}${chalk.dim("Prompt fit")}  ${Math.round(entry.promptFit * 100)}%  ` +
        chalk.dim(`name ${entry.breakdown.promptFit.nameMatches}  desc ${entry.breakdown.promptFit.descriptionMatches}  readme ${entry.breakdown.promptFit.readmeMatches}  topics ${entry.breakdown.promptFit.topicMatches}`)
      );
      lines.push(
        `${pad}${chalk.dim("Health")}      ` +
        chalk.dim(
          `readme ${Math.round(entry.breakdown.health.readmeQuality * 25)}/25  ` +
          `velocity ${Math.round(entry.breakdown.health.starsVelocity * 25)}/25  ` +
          `deps ${Math.round(entry.breakdown.health.dependencyFreshness * 20)}/20  ` +
          `maintenance ${Math.round(entry.breakdown.health.maintenanceQuality * 15)}/15  ` +
          `owner ${Math.round(entry.breakdown.health.ownerQuality * 15)}/15`
        )
      );
    }

    lines.push(`${pad}${chalk.blue.underline(`https://github.com/${entry.repo.fullName}`)}`);
    lines.push(`\n  ${HR}`);
  });

  return `${lines.join("\n")}\n`;
}
