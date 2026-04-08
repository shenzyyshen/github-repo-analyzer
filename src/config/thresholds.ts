/**
 * Central threshold configuration for the staged repo search pipeline.
 * All tunable constants live here so ranking behaviour can be adjusted
 * without touching application logic.
 */

// ---------------------------------------------------------------------------
// Owner intelligence
// ---------------------------------------------------------------------------

export const KNOWN_ELITE_OWNERS = new Set([
  "anthropic",
  "openai",
  "microsoft",
  "google",
  "huggingface",
  "langchain-ai",
  "vercel",
  "meta",
  "mozilla",
  "facebook",
  "redis",
  "postgres",
  "apache",
]);

export const OWNER_TIER_THRESHOLDS = {
  elite:     { stars: 50_000, forks: 5_000 },
  strong:    { stars:  5_000, forks:   500 },
  promising: { stars:    250, forks:    25, activeDays: 90 },
} as const;

export const OWNER_TIER_SCORES = {
  Elite:     1.0,
  Strong:    0.8,
  Promising: 0.55,
  Weak:      0.25,
} as const;

// ---------------------------------------------------------------------------
// Domain speed classification
// ---------------------------------------------------------------------------

export const DOMAIN_SPEED_TERMS = {
  fast: /\b(llm|claude|openai|mcp|agent|agents|rag|eval|evals|inference|coding assistant)\b/i,
  slow: /\b(kernel|compiler|database|postgres|redis|infra|library|sdk)\b/i,
} as const;

// ---------------------------------------------------------------------------
// Freshness thresholds (in days, per domain speed)
// ---------------------------------------------------------------------------

export const FRESHNESS_THRESHOLDS = {
  fast:   { soft: 120,  hard: 240,  disqualify: 420  },
  medium: { soft: 180,  hard: 365,  disqualify: 540  },
  slow:   { soft: 540,  hard: 1095, disqualify: 1825 },
} as const;

export const FRESHNESS_COMPOSITE_WEIGHTS = {
  push:        0.6,
  release:     0.3,
  terminology: 0.1,
} as const;

export const FRESHNESS_PUSH_SCORES = {
  soft:       1.0,
  hard:       0.6,
  disqualify: 0.25,
  expired:    0,
} as const;

export const FRESHNESS_RELEASE_SCORES = {
  soft:              1.0,
  hard:              0.7,
  disqualify:        0.35,
  expiredWithRelease: 0,
  expiredNoRelease:  0.4,
} as const;

// ---------------------------------------------------------------------------
// Minimum star floors (per domain speed, adjusted by owner tier)
// ---------------------------------------------------------------------------

export const STAR_FLOOR_BASE = {
  fast:   30,
  medium: 20,
  slow:   10,
} as const;

export const STAR_FLOOR_ELITE   = { min: 5,  divisor:    2    } as const;
export const STAR_FLOOR_STRONG  = { min: 10, multiplier: 0.75 } as const;

// ---------------------------------------------------------------------------
// Stage 2 — quality gate
// ---------------------------------------------------------------------------

export const STAGE2 = {
  eliteReadmeExemptionMinStars: 10_000,
  minReadmeLength:               300,
  minKeywordOverlap:             0.08,
} as const;

// ---------------------------------------------------------------------------
// Stage 3 — prompt-fit thresholds
// ---------------------------------------------------------------------------

export const PROMPT_FIT_THRESHOLDS = {
  narrow: 0.35,
  broad:  0.25,
} as const;

export const PROMPT_FIT_WEIGHTS = {
  name:        0.28,
  description: 0.18,
  readme:      0.14,
  topics:      0.14,
  language:    0.16,
  artifact:    0.10,
} as const;

// ---------------------------------------------------------------------------
// Stage 4 — health score
// ---------------------------------------------------------------------------

export const HEALTH_SCORE_FLOOR = 25;

export const HEALTH_WEIGHTS = {
  readmeQuality:       25,
  starsVelocity:       25,
  dependencyFreshness: 20,
  maintenanceQuality:  15,
  ownerQuality:        15,
} as const;

export const HEALTH_DEPENDENCY_SCORES = {
  Clean:                1.0,
  "Minor risk":         0.6,
  "Supply chain risk":  0.15,
} as const;

export const README_QUALITY_WEIGHTS = {
  length:  0.25,
  overlap: 0.30,
  install: 0.20,
  usage:   0.25,
} as const;

export const README_LENGTH_TARGET = 1_200;

export const STARS_VELOCITY_DIVISOR = 400; // stars/month that yields max velocity score

export const MAINTENANCE_SIGNALS = {
  recentPushDays:       30,
  activePushDays:      120,
  recentReleaseDays:   120,
  minContributorsGood:   5,
  minContributorsOk:     2,
  maxIssuesGood:       100,
  scores: {
    recentPush:      0.40,
    activePush:      0.20,
    release:         0.25,
    releaseAbsent:   0.05,
    contributorsGood: 0.20,
    contributorsOk:  0.10,
    issuesGood:      0.15,
    issuesAbsent:    0.05,
  },
} as const;

// ---------------------------------------------------------------------------
// Ranking weights (per domain speed)
// ---------------------------------------------------------------------------

export const RANKING_WEIGHTS = {
  fast: { promptFit: 0.35, health: 0.25, freshness: 0.20, ownerTier: 0.10, stars: 0.10, maintenance: 0    },
  slow: { promptFit: 0.30, health: 0.25, freshness: 0.05, ownerTier: 0.10, stars: 0.20, maintenance: 0.10 },
} as const;

export const FRESHNESS_OVERRIDE_DELTA = 0.15;

// ---------------------------------------------------------------------------
// Confidence thresholds
// ---------------------------------------------------------------------------

export const CONFIDENCE_THRESHOLDS = {
  high:   { minStage3: 6, minGap: 0.08 },
  medium: { minStage3: 3, minGap: 0.04 },
} as const;

// ---------------------------------------------------------------------------
// Preselection (Stage 1 → enrichment candidate pool)
// ---------------------------------------------------------------------------

export const PRESELECT = {
  poolMultiplier: 5,
  poolMin:        20,
  poolCap:        30,
  termMatchWeight: 3,
  activityBonus: {
    recentDays:  30,  recentBonus: 2,
    activeDays: 120,  activeBonus: 1,
  },
  starBonuses: [
    { minStars: 20_000, bonus: 4 },
    { minStars:  5_000, bonus: 3 },
    { minStars:    500, bonus: 2 },
    { minStars:     50, bonus: 1 },
  ],
} as const;
