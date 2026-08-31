import type { AnalyzeRepo } from "./AnalyzeRepo.js";
import type { RepoApiPort } from "../../ports/RepoApiPort.js";
import type { RepoIntelligencePort } from "../../ports/RepoIntelligencePort.js";
import { inferFilters, type ParsedIntent, type SearchInput } from "./ParseIntent.js";
import { DiscoverRepos } from "./DiscoverRepos.js";
import { applyQualityGates } from "./ApplyQualityGates.js";
import { ScoreAndRank, confidenceLabel, type RankedRepo } from "./ScoreAndRank.js";
import { clamp } from "../shared/pipelineUtils.js";
import type {
  ArtifactType,
  DomainSpeed,
  FreshnessOverride,
  IntentClassification,
  IntentMode,
  OwnerPreference,
  Specificity,
} from "../entities/IntentClassification.js";
import { DOMAIN_SPEED_TERMS } from "../../config/thresholds.js";

export type StagedSearchOptions = {
  requestedMode?: IntentMode;
  top: number;
  random?: boolean;
  explain?: boolean;
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

/**
 * Stage 0 classification: turns the raw prompt plus parsed intent into the
 * pipeline's steering signals (how fast the domain moves, how specific the
 * ask is, whether to return one match or a shortlist, freshness bias).
 */
export function classifyIntent(
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

/**
 * Use case: the full staged discovery pipeline, Stage 0 through Stage 5.
 *
 * Composes ParseIntent -> DiscoverRepos -> ApplyQualityGates -> ScoreAndRank
 * and trims to the requested result count, attaching confidence labels and
 * close-alternative notes. Returns structured data only — rendering belongs
 * to whichever driving adapter called it (CLI, MCP, HTTP).
 */
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

  const qualityPassed = applyQualityGates(enriched, classification, intent);

  const scoreAndRank = new ScoreAndRank(repoIntelligencePort);
  const { promptFitPassedCount, ranked } = await scoreAndRank.execute(qualityPassed, classification, intent);

  // Confidence describes how trustworthy the ranking is as a whole — it is
  // not a per-repo quality signal — so it's computed once, from the actual
  // top-two gap in the full ranked list, and applied to every returned
  // result. (Previously this ran once per row with `arr[1]` from the
  // already-trimmed slice: correct for rank 0 in best_shortlist mode, but
  // in best_match mode `arr` only ever had one element, so even rank 0 fell
  // through to a hardcoded gap; every row past rank 0 always did, since
  // `index === 0` was false. That hardcoded 0.1 clears the "High" gap
  // threshold, so ranks 2+ read High regardless of how close the scores
  // actually were, while rank 0 in best_match mode could read Low despite
  // a real, wide gap. See KNOWN_ISSUES.md.)
  const topGap = ranked[1] ? ranked[0].finalScore - ranked[1].finalScore : 0.1;
  const searchConfidence = confidenceLabel({ stage3PromptFit: promptFitPassedCount }, topGap);

  // Same "compare against the real pool, not whatever got trimmed for
  // display" fix as confidence above. Previously this compared the top
  // result against `arr.slice(1, 4)` of the already-trimmed results array,
  // so in best_match mode (returnedCount 1) there was never anything past
  // index 0 to compare against — alternativesNote was always null even
  // when a close rank-2 candidate existed in the full ranked pool.
  const topResult = ranked[0];
  const closeAlternatives = topResult
    ? ranked
        .slice(1, 4)
        .filter((candidate) => Math.abs(candidate.healthScore - topResult.healthScore) <= 15)
        .map((candidate) => `${candidate.repo.fullName} (${candidate.artifactType}, health ${candidate.healthScore})`)
    : [];
  const topAlternativesNote =
    closeAlternatives.length > 0 ? `Alternatives worth knowing: ${closeAlternatives.join("; ")}` : null;

  const returnedCount = classification.intentMode === "best_match" ? 1 : options.top;
  const results = ranked.slice(0, returnedCount).map((result, index) => ({
    ...result,
    confidence: searchConfidence,
    alternativesNote: index === 0 ? topAlternativesNote : null,
  }));

  return {
    query: originalQuery,
    filters: search,
    appliedFilters: applied,
    intent,
    classification,
    stageCounts: {
      stage1Raw: stage1Raw.length,
      stage2QualityFloor: qualityPassed.length,
      stage3PromptFit: promptFitPassedCount,
      stage4Ranked: ranked.length,
      stage5Returned: results.length,
    },
    results,
  };
}
