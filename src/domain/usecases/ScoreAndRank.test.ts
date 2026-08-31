import { describe, expect, it, vi } from "vitest";
import { ScoreAndRank, confidenceLabel } from "./ScoreAndRank.js";
import { parseIntent } from "./ParseIntent.js";
import type { EnrichedRepo } from "./DiscoverRepos.js";
import type { SearchResult } from "../entities/SearchResult.js";
import type { Metrics } from "../entities/Metrics.js";
import type { DomainSpeed, FreshnessOverride, IntentClassification } from "../entities/IntentClassification.js";
import type { RepoIntelligencePort } from "../../ports/RepoIntelligencePort.js";
import { RANKING_WEIGHTS } from "../../config/thresholds.js";

function makeRepo(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
    description: "A self-hosted monitoring widget for websites and APIs",
    stars: 100_000,
    forks: 5_000,
    archived: false,
    isFork: false,
    language: "TypeScript",
    createdAt: new Date(Date.now() - 2000 * 24 * 60 * 60 * 1000),
    pushedAt: new Date(),
    topics: ["monitoring", "self-hosted"],
    ...overrides,
  };
}

const goodReadme = [
  "# Widget",
  "A self-hosted monitoring widget for websites and APIs.",
  "## Install",
  "npm install widget",
  "## Usage",
  "```js\nconst widget = require('widget');\n```",
  "Extra padding text to comfortably clear the README length target. ".repeat(20),
].join("\n");

const goodMetrics: Metrics = {
  repoOwner: "acme",
  repoName: "widget",
  stars: 100_000,
  starGrowth24h: "+0 (0%)",
  languages: {},
  openIssues: 10,
  contributors: 50,
  lastCommit: new Date(),
  analyzedAt: new Date(),
};

function makeEnriched(overrides: Partial<EnrichedRepo> = {}): EnrichedRepo {
  return {
    search: makeRepo(),
    metrics: goodMetrics,
    readme: goodReadme,
    rootContents: [],
    latestRelease: { tagName: "v1.0.0", publishedAt: new Date() },
    analysisError: null,
    ...overrides,
  };
}

const classification: IntentClassification = {
  artifactType: "tool",
  domainSpeed: "medium",
  specificity: "broad",
  intentMode: "best_shortlist",
  freshnessOverride: "none",
  ownerPreference: "any",
  confidence: 0.8,
};

const intent = parseIntent("self-hosted monitoring widget for websites and apis");

function makeMockIntelligencePort(): RepoIntelligencePort {
  return {
    saveSnapshot: vi.fn().mockResolvedValue(undefined),
    saveHealthScore: vi.fn().mockResolvedValue(undefined),
  };
}

describe("confidenceLabel", () => {
  it("is Low when the stage-3 pool is thin or the score gap is small", () => {
    expect(confidenceLabel({ stage3PromptFit: 1 }, 0.5)).toBe("Low");
    expect(confidenceLabel({ stage3PromptFit: 10 }, 0.01)).toBe("Low");
  });

  it("is High when the pool is large and the gap is wide", () => {
    expect(confidenceLabel({ stage3PromptFit: 10 }, 0.5)).toBe("High");
  });

  it("is Medium in between", () => {
    expect(confidenceLabel({ stage3PromptFit: 4 }, 0.05)).toBe("Medium");
  });
});

describe("ScoreAndRank.execute", () => {
  it("ranks a strong candidate and persists its intelligence data", async () => {
    const port = makeMockIntelligencePort();
    const scoreAndRank = new ScoreAndRank(port);

    const { promptFitPassedCount, ranked } = await scoreAndRank.execute([makeEnriched()], classification, intent);

    expect(promptFitPassedCount).toBe(1);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].repo.fullName).toBe("acme/widget");
    expect(ranked[0].healthScore).toBeGreaterThanOrEqual(25);
    expect(ranked[0].decay).toBe("Healthy");
    expect(port.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(port.saveHealthScore).toHaveBeenCalledTimes(1);
    expect(port.saveHealthScore).toHaveBeenCalledWith(
      expect.objectContaining({ fullName: "acme/widget", score: ranked[0].healthScore })
    );
  });

  it("drops candidates below the prompt-fit threshold", async () => {
    const unrelated = makeEnriched({
      search: makeRepo({
        fullName: "acme/zephyr",
        name: "zephyr",
        description: "A physics simulation engine",
        topics: ["physics"],
      }),
      readme: "A physics simulation engine. ".repeat(50),
    });

    const scoreAndRank = new ScoreAndRank(makeMockIntelligencePort());
    const { ranked } = await scoreAndRank.execute([unrelated], classification, intent);

    expect(ranked).toHaveLength(0);
  });

  it("drops candidates whose health score falls below the floor", async () => {
    const weak = makeEnriched({
      search: makeRepo({
        fullName: "acme/weak",
        stars: 1,
        forks: 0,
        createdAt: new Date("2020-01-01"),
        pushedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        description: "A deprecated, unmaintained self-hosted monitoring widget",
      }),
      metrics: { ...goodMetrics, repoName: "weak", contributors: 0, openIssues: 500 },
      readme: null,
      latestRelease: null,
    });

    const scoreAndRank = new ScoreAndRank(makeMockIntelligencePort());
    const { promptFitPassedCount, ranked } = await scoreAndRank.execute([weak], classification, intent);

    expect(promptFitPassedCount).toBeGreaterThan(0);
    expect(ranked).toHaveLength(0);
  });

  it("drops candidates whose decay label is Abandoned even with a passing health score", async () => {
    const stale = makeEnriched({
      search: makeRepo({
        fullName: "acme/stale",
        pushedAt: new Date(Date.now() - 600 * 24 * 60 * 60 * 1000),
      }),
      latestRelease: null,
    });

    const scoreAndRank = new ScoreAndRank(makeMockIntelligencePort());
    const { ranked } = await scoreAndRank.execute([stale], classification, intent);

    expect(ranked).toHaveLength(0);
  });

  it("sorts surviving candidates by final score descending", async () => {
    const strong = makeEnriched({ search: makeRepo({ fullName: "acme/strong", stars: 200_000 }) });
    const weaker = makeEnriched({
      search: makeRepo({ fullName: "acme/weaker", stars: 60_000, forks: 100 }),
      metrics: { ...goodMetrics, repoName: "weaker", contributors: 6, openIssues: 80 },
    });

    const scoreAndRank = new ScoreAndRank(makeMockIntelligencePort());
    const { ranked } = await scoreAndRank.execute([weaker, strong], classification, intent);

    expect(ranked.map((r) => r.repo.fullName)).toEqual(["acme/strong", "acme/weaker"]);
    expect(ranked[0].finalScore).toBeGreaterThanOrEqual(ranked[1].finalScore);
  });

  it("continues past a snapshot/health-score persistence failure without losing results", async () => {
    const port = makeMockIntelligencePort();
    (port.saveSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const scoreAndRank = new ScoreAndRank(port);
    const { ranked } = await scoreAndRank.execute([makeEnriched()], classification, intent);

    expect(ranked).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("reports a persistence failure once for the batch, without the raw error body", async () => {
    const port = makeMockIntelligencePort();
    const prismaOffline = new Error(
      "\nInvalid `this.prisma.repoSnapshot.create()` invocation in\n/app/PrismaAdapter.ts:131:36\n\nCan't reach database server at `localhost:5432`"
    );
    prismaOffline.name = "PrismaClientInitializationError";
    (port.saveSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(prismaOffline);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const scoreAndRank = new ScoreAndRank(port);
    const { ranked } = await scoreAndRank.execute(
      [makeEnriched(), makeEnriched(), makeEnriched()],
      classification,
      intent
    );

    expect(ranked.length).toBeGreaterThan(1);
    expect(consoleError).toHaveBeenCalledTimes(1);

    const logged = consoleError.mock.calls[0].join(" ");
    expect(logged).toContain(`${ranked.length} repo(s)`);
    expect(logged).toContain("database offline");
    expect(logged).not.toContain("prisma.repoSnapshot.create");
    consoleError.mockRestore();
  });
});

describe("ScoreAndRank ranking weight conservation", () => {
  async function rankOne(domainSpeed: DomainSpeed, freshnessOverride: FreshnessOverride) {
    const scoreAndRank = new ScoreAndRank(makeMockIntelligencePort());
    const { ranked } = await scoreAndRank.execute(
      [makeEnriched()],
      { ...classification, domainSpeed, freshnessOverride },
      intent
    );
    return ranked[0];
  }

  it.each([
    ["fast", "none"], ["fast", "strict"], ["fast", "relaxed"],
    ["slow", "none"], ["slow", "strict"], ["slow", "relaxed"],
  ] as const)("sums to 1.0 for domainSpeed=%s freshnessOverride=%s", async (domainSpeed, freshnessOverride) => {
    const result = await rankOne(domainSpeed, freshnessOverride);
    const total = Object.values(result.breakdown.ranking).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("pulls the strict-freshness boost from health, leaving stars and ownerTier untouched", async () => {
    const base = RANKING_WEIGHTS.fast;
    const result = await rankOne("fast", "strict");

    expect(result.breakdown.ranking.stars).toBe(base.stars);
    expect(result.breakdown.ranking.ownerTier).toBe(base.ownerTier);
    expect(result.breakdown.ranking.freshness).toBeGreaterThan(base.freshness);
    expect(result.breakdown.ranking.health).toBeLessThan(base.health);
  });

  it("does not change stars or ownerTier weight for relaxed freshness either", async () => {
    const base = RANKING_WEIGHTS.slow;
    const result = await rankOne("slow", "relaxed");

    expect(result.breakdown.ranking.stars).toBe(base.stars);
    expect(result.breakdown.ranking.ownerTier).toBe(base.ownerTier);
  });
});

describe("ScoreAndRank whyThisRepo", () => {
  it("states the star count as part of the reasoning, not just as a separate stat", async () => {
    const scoreAndRank = new ScoreAndRank(makeMockIntelligencePort());
    const { ranked } = await scoreAndRank.execute(
      [makeEnriched({ search: makeRepo({ stars: 87_654 }) })],
      classification,
      intent
    );

    expect(ranked[0].whyThisRepo).toContain("Stars: 87,654");
  });

  it("flags a fresh release from an elite-tier owner", async () => {
    const scoreAndRank = new ScoreAndRank(makeMockIntelligencePort());
    const { ranked } = await scoreAndRank.execute(
      [
        makeEnriched({
          search: makeRepo({ owner: "anthropic", stars: 60_000, pushedAt: new Date() }),
          latestRelease: { tagName: "v1.0.0", publishedAt: new Date() },
        }),
      ],
      classification,
      intent
    );

    expect(ranked[0].ownerTier).toBe("Elite");
    expect(ranked[0].whyThisRepo).toContain("Notable: fresh release from an established maintainer");
  });

  it("does not flag a non-elite owner even when freshly released", async () => {
    const scoreAndRank = new ScoreAndRank(makeMockIntelligencePort());
    const { ranked } = await scoreAndRank.execute(
      [
        makeEnriched({
          search: makeRepo({ owner: "randodev", stars: 500, forks: 10, pushedAt: new Date() }),
          latestRelease: { tagName: "v1.0.0", publishedAt: new Date() },
        }),
      ],
      classification,
      intent
    );

    expect(ranked[0].ownerTier).not.toBe("Elite");
    expect(ranked[0].whyThisRepo).not.toContain("Notable:");
  });

  it("does not flag an elite owner whose repo is stale", async () => {
    // Old enough to fail the "recently active" (<=30 days) check, but well
    // inside the medium-domain decay disqualify threshold (540 days) so it
    // survives to be ranked at all rather than being dropped as Abandoned.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const scoreAndRank = new ScoreAndRank(makeMockIntelligencePort());
    const { ranked } = await scoreAndRank.execute(
      [
        makeEnriched({
          search: makeRepo({ owner: "anthropic", stars: 60_000, pushedAt: ninetyDaysAgo }),
          latestRelease: { tagName: "v1.0.0", publishedAt: ninetyDaysAgo },
        }),
      ],
      classification,
      intent
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0].ownerTier).toBe("Elite");
    expect(ranked[0].whyThisRepo).not.toContain("Notable:");
  });
});
