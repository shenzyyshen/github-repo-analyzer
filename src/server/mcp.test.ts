import { describe, expect, it } from "vitest";
import { toMcpSearchPayload } from "./mcp.js";
import type { StagedSearchResult } from "../domain/usecases/SearchRepos.js";
import type { RankedRepo } from "../domain/usecases/ScoreAndRank.js";
import type { SearchResult } from "../domain/entities/SearchResult.js";
import type { IntentClassification } from "../domain/entities/IntentClassification.js";
import { parseIntent } from "../domain/usecases/ParseIntent.js";

const classification: IntentClassification = {
  artifactType: "tool",
  domainSpeed: "medium",
  specificity: "narrow",
  intentMode: "best_shortlist",
  freshnessOverride: "none",
  ownerPreference: "any",
  confidence: 0.83,
};

const repo: SearchResult = {
  owner: "apache",
  name: "hertzbeat",
  fullName: "apache/hertzbeat",
  description: "Real-time monitoring system",
  stars: 6000,
  forks: 1000,
  archived: false,
  isFork: false,
  language: "Java",
  createdAt: new Date("2021-01-01"),
  pushedAt: new Date("2026-07-01T00:00:00.000Z"),
  topics: ["monitoring"],
};

const ranked: RankedRepo = {
  repo,
  metrics: null,
  readme: "a".repeat(50_000),
  latestRelease: null,
  classification,
  ownerTier: "Elite",
  dependencyHealth: "Clean",
  decay: "Healthy",
  confidence: "High",
  artifactType: "tool",
  promptFit: 0.987654,
  freshness: 0.812345,
  healthScore: 76,
  finalScore: 0.7654321,
  whyThisRepo: "Match: strong direct fit | Owner: Elite",
  note: null,
  alternativesNote: null,
  breakdown: {
    promptFit: {
      score: 0.987654,
      nameMatches: 1,
      descriptionMatches: 2,
      readmeMatches: 3,
      topicMatches: 1,
      languageMatched: false,
      artifactMatched: true,
    },
    health: {
      readmeQuality: 0.8,
      starsVelocity: 0.5,
      dependencyFreshness: 1,
      maintenanceQuality: 0.7,
      ownerQuality: 1,
    },
    ranking: { promptFit: 0.3, health: 0.25, freshness: 0.05, ownerTier: 0.1, stars: 0.2, maintenance: 0.1 },
  },
};

const result: StagedSearchResult = {
  query: "self-hosted uptime monitoring",
  filters: {
    query: "monitoring",
    language: null,
    minStars: 0,
    since: null,
    license: null,
    sort: "stars",
    top: 5,
    random: false,
  },
  appliedFilters: ["Purpose: monitoring"],
  intent: parseIntent("self-hosted uptime monitoring"),
  classification,
  stageCounts: {
    stage1Raw: 200,
    stage2QualityFloor: 6,
    stage3PromptFit: 6,
    stage4Ranked: 6,
    stage5Returned: 1,
  },
  results: [ranked],
};

describe("toMcpSearchPayload", () => {
  it("surfaces the decision-relevant fields for each result", () => {
    const payload = toMcpSearchPayload(result);
    const entry = payload.results[0];

    expect(entry.fullName).toBe("apache/hertzbeat");
    expect(entry.url).toBe("https://github.com/apache/hertzbeat");
    expect(entry.healthScore).toBe(76);
    expect(entry.decay).toBe("Healthy");
    expect(entry.ownerTier).toBe("Elite");
    expect(entry.confidence).toBe("High");
    expect(entry.whyThisRepo).toContain("strong direct fit");
  });

  it("omits README text and scoring internals that would waste client context", () => {
    const serialized = JSON.stringify(toMcpSearchPayload(result));

    expect(serialized).not.toContain("aaaaaaaaaa");
    expect(serialized).not.toContain("nameMatches");
    expect(serialized).not.toContain("starsVelocity");
    expect(serialized.length).toBeLessThan(2_000);
  });

  it("rounds float scores so the model isn't handed 16 decimal places", () => {
    const entry = toMcpSearchPayload(result).results[0];

    expect(entry.promptFit).toBe(0.99);
    expect(entry.freshness).toBe(0.81);
    expect(entry.finalScore).toBe(0.765);
  });

  it("serializes dates as ISO strings rather than Date objects", () => {
    const entry = toMcpSearchPayload(result).results[0];
    expect(entry.lastPushed).toBe("2026-07-01T00:00:00.000Z");
  });

  it("passes through the stage funnel so a thin pool is visible to the caller", () => {
    const payload = toMcpSearchPayload(result);
    expect(payload.stageCounts.stage1Raw).toBe(200);
    expect(payload.stageCounts.stage2QualityFloor).toBe(6);
    expect(payload.stageCounts.stage5Returned).toBe(1);
  });
});
