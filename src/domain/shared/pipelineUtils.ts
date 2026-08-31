import type { SearchResult } from "../entities/SearchResult.js";
import type { ParsedIntent } from "../usecases/ParseIntent.js";
import type { DomainSpeed, OwnerTier } from "../entities/IntentClassification.js";
import { FRESHNESS_THRESHOLDS, KNOWN_ELITE_OWNERS, OWNER_TIER_SCORES, OWNER_TIER_THRESHOLDS } from "../../config/thresholds.js";

/**
 * Small pure helpers shared across the staged-search pipeline stages
 * (discovery, quality gates, scoring). Kept together because they're all
 * used identically wherever repo text or dates need normalizing, the same
 * way thresholds.ts is one central place for pipeline config.
 */

export function normalizeText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

export function daysSince(date: Date | null | undefined): number {
  if (!date) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)));
}

export function tokenizeRepo(repo: SearchResult, readme: string | null): Set<string> {
  return new Set(
    normalizeText(
      [
        repo.fullName,
        repo.name,
        repo.description ?? "",
        repo.language ?? "",
        ...(repo.topics ?? []),
        readme ?? "",
      ].join(" ")
    )
  );
}

export function ownerTierFor(repo: SearchResult): OwnerTier {
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

export function ownerTierScore(tier: OwnerTier): number {
  return OWNER_TIER_SCORES[tier];
}

export function domainFreshnessThresholds(speed: DomainSpeed): { soft: number; hard: number; disqualify: number } {
  return FRESHNESS_THRESHOLDS[speed];
}

export function keywordOverlap(intent: ParsedIntent, repo: SearchResult, readme: string | null): number {
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
