import type { ParsedIntent } from "./ParseIntent.js";
import type { EnrichedRepo } from "./DiscoverRepos.js";
import type { IntentClassification, OwnerTier } from "../entities/IntentClassification.js";
import { daysSince, domainFreshnessThresholds, keywordOverlap, ownerTierFor } from "../shared/pipelineUtils.js";
import { STAGE2, STAR_FLOOR_BASE, STAR_FLOOR_ELITE, STAR_FLOOR_STRONG } from "../../config/thresholds.js";

function minimumStarsFor(speed: IntentClassification["domainSpeed"], ownerTier: OwnerTier): number {
  const base = STAR_FLOOR_BASE[speed];
  if (ownerTier === "Elite") return Math.max(STAR_FLOOR_ELITE.min, Math.floor(base / STAR_FLOOR_ELITE.divisor));
  if (ownerTier === "Strong") return Math.max(STAR_FLOOR_STRONG.min, Math.floor(base * STAR_FLOOR_STRONG.multiplier));
  return base;
}

/**
 * The reason a repo failed Stage 2, or null if it passed. Exposed alongside
 * the filtered list (not just a boolean) so callers can explain a rejection
 * later, even though today's CLI only consumes the pass/fail count.
 */
export function stage2GateReason(
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

/**
 * Use case: Stage 2 of the staged search pipeline — drop obvious failures
 * (archived, forks, missing/thin README, weak prompt overlap, stale, below
 * the domain-appropriate star floor) before the more expensive prompt-fit
 * and health scoring stages run.
 */
export function applyQualityGates(
  candidates: EnrichedRepo[],
  classification: IntentClassification,
  intent: ParsedIntent
): EnrichedRepo[] {
  return candidates.filter((repo) => {
    const ownerTier = ownerTierFor(repo.search);
    return !stage2GateReason(repo, classification, intent, ownerTier);
  });
}
