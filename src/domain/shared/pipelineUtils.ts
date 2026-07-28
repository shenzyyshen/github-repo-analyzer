import type { SearchResult } from "../entities/SearchResult.js";

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
