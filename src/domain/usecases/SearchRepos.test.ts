import { describe, expect, it, vi } from "vitest";
import { runStagedSearch, type StagedSearchOptions } from "./SearchRepos.js";
import type { AnalyzeRepo } from "./AnalyzeRepo.js";
import type { RepoApiPort } from "../../ports/RepoApiPort.js";
import type { RepoIntelligencePort } from "../../ports/RepoIntelligencePort.js";
import type { SearchInput } from "./ParseIntent.js";
import type { SearchResult } from "../entities/SearchResult.js";
import type { Metrics } from "../entities/Metrics.js";

const goodReadme = [
  "# Widget",
  "A self-hosted monitoring widget for websites and APIs.",
  "## Install",
  "npm install widget",
  "## Usage",
  "```js\nconst widget = require('widget');\n```",
  "Extra padding text to comfortably clear the README length target. ".repeat(20),
].join("\n");

function makeCandidatePool(count: number): SearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    owner: "acme",
    name: `widget-${i}`,
    fullName: `acme/widget-${i}`,
    description: "A self-hosted monitoring widget for websites and APIs",
    // Descending star counts give a real, deterministic ranking — every
    // candidate is still comfortably above the elite owner-tier threshold.
    stars: 500_000 - i * 20_000,
    forks: 5_000,
    archived: false,
    isFork: false,
    language: "TypeScript",
    createdAt: new Date(Date.now() - 2000 * 24 * 60 * 60 * 1000),
    pushedAt: new Date(),
    topics: ["monitoring", "self-hosted"],
  }));
}

function makeMockRepoApiPort(pool: SearchResult[]): RepoApiPort {
  return {
    getRepo: vi.fn(),
    getLanguages: vi.fn(),
    getIssues: vi.fn(),
    getContributors: vi.fn(),
    getReadme: vi.fn().mockResolvedValue(goodReadme),
    getRootContents: vi.fn().mockResolvedValue([{ name: "package.json", path: "package.json", type: "file" }]),
    getLatestRelease: vi.fn().mockResolvedValue({ tagName: "v1.0.0", publishedAt: new Date() }),
    searchRepos: vi.fn().mockResolvedValue(pool),
  };
}

function makeMockAnalyzeRepo(): AnalyzeRepo {
  const metrics: Metrics = {
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
  return { execute: vi.fn().mockResolvedValue(metrics) } as unknown as AnalyzeRepo;
}

function makeMockIntelligencePort(): RepoIntelligencePort {
  return {
    saveSnapshot: vi.fn().mockResolvedValue(undefined),
    saveHealthScore: vi.fn().mockResolvedValue(undefined),
  };
}

const baseSearch: SearchInput = {
  query: "monitoring",
  language: null,
  minStars: 0,
  since: null,
  license: null,
  sort: "stars",
  top: 6,
  random: false,
};

const query = "self-hosted monitoring dashboard for websites and apis";

async function runSearch(pool: SearchResult[], options: StagedSearchOptions) {
  return runStagedSearch(
    makeMockRepoApiPort(pool),
    makeMockAnalyzeRepo(),
    makeMockIntelligencePort(),
    query,
    baseSearch,
    options
  );
}

describe("runStagedSearch confidence", () => {
  it("assigns the same confidence label to every result in a multi-result shortlist", async () => {
    const pool = makeCandidatePool(6);
    const { results } = await runSearch(pool, { top: 6, requestedMode: "best_shortlist" });

    expect(results.length).toBeGreaterThan(1);
    const distinctConfidences = new Set(results.map((r) => r.confidence));
    expect(distinctConfidences.size).toBe(1);
  });

  it("gives the top result the same confidence whether the caller asks for one result or several", async () => {
    const pool = makeCandidatePool(6);

    const shortlist = await runSearch(pool, { top: 6, requestedMode: "best_shortlist" });
    const bestMatch = await runSearch(pool, { top: 6, requestedMode: "best_match" });

    expect(bestMatch.results).toHaveLength(1);
    expect(bestMatch.results[0].repo.fullName).toBe(shortlist.results[0].repo.fullName);
    // Same underlying ranking, same real gap to rank 2 — trimming to one
    // result must not change how confident that result is. Previously it
    // did: best_match mode always fell back to a hardcoded gap because it
    // compared against the already-trimmed (length-1) results array
    // instead of the full ranked pool.
    expect(bestMatch.results[0].confidence).toBe(shortlist.results[0].confidence);
  });

  it("falls back gracefully when only one candidate survives to be ranked", async () => {
    const pool = makeCandidatePool(1);
    const { results } = await runSearch(pool, { top: 5, requestedMode: "best_shortlist" });

    expect(results).toHaveLength(1);
    expect(["Low", "Medium", "High"]).toContain(results[0].confidence);
  });
});
