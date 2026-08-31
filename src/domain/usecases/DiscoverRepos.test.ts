import { describe, expect, it, vi } from "vitest";
import { DiscoverRepos } from "./DiscoverRepos.js";
import { parseIntent, type SearchInput } from "./ParseIntent.js";
import type { AnalyzeRepo } from "./AnalyzeRepo.js";
import type { RepoApiPort } from "../../ports/RepoApiPort.js";
import type { SearchResult } from "../entities/SearchResult.js";
import type { Metrics } from "../entities/Metrics.js";

function makeRepo(fullName: string, overrides: Partial<SearchResult> = {}): SearchResult {
  const [owner, name] = fullName.split("/");
  return {
    owner,
    name,
    fullName,
    description: null,
    stars: 100,
    forks: 10,
    archived: false,
    isFork: false,
    language: "TypeScript",
    createdAt: new Date("2024-01-01"),
    pushedAt: new Date("2026-06-01"),
    topics: [],
    ...overrides,
  };
}

function makeMockRepoApiPort(overrides: Partial<RepoApiPort> = {}): RepoApiPort {
  return {
    getRepo: vi.fn(),
    getLanguages: vi.fn(),
    getIssues: vi.fn(),
    getContributors: vi.fn(),
    getReadme: vi.fn().mockResolvedValue(null),
    getRootContents: vi.fn().mockResolvedValue([]),
    getLatestRelease: vi.fn().mockResolvedValue(null),
    searchRepos: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeMockAnalyzeRepo(metrics: Metrics | null = null): AnalyzeRepo {
  return { execute: vi.fn().mockResolvedValue(metrics) } as unknown as AnalyzeRepo;
}

const baseSearch: SearchInput = {
  query: "monitoring",
  language: null,
  minStars: 0,
  since: null,
  license: null,
  sort: "stars",
  top: 5,
  random: false,
};

describe("DiscoverRepos.execute", () => {
  it("merges and dedupes results across multiple retrieval queries", async () => {
    const intent = parseIntent("self-hosted monitoring dashboard for apis and websites");

    const batches = [
      [makeRepo("acme/monitor"), makeRepo("acme/shared")],
      [makeRepo("acme/shared"), makeRepo("acme/other")],
    ];
    let call = 0;
    const repoApiPort = makeMockRepoApiPort({
      searchRepos: vi.fn().mockImplementation(async () => batches[Math.min(call++, batches.length - 1)]),
    });

    const discoverRepos = new DiscoverRepos(repoApiPort, makeMockAnalyzeRepo());
    const result = await discoverRepos.execute(intent, baseSearch, { top: 5 });

    const fullNames = result.stage1Raw.map((r) => r.fullName).sort();
    expect(fullNames).toEqual(["acme/monitor", "acme/other", "acme/shared"]);
  });

  it("enriches each preselected candidate with readme, root contents, release, and metrics", async () => {
    const intent = parseIntent("monitoring");
    const metrics: Metrics = {
      repoOwner: "acme",
      repoName: "monitor",
      stars: 100,
      starGrowth24h: "+0 (0%)",
      languages: {},
      openIssues: 3,
      contributors: 5,
      lastCommit: new Date("2026-06-01"),
      analyzedAt: new Date("2026-07-01"),
    };

    const repoApiPort = makeMockRepoApiPort({
      searchRepos: vi.fn().mockResolvedValue([makeRepo("acme/monitor")]),
      getReadme: vi.fn().mockResolvedValue("# Monitor\nSelf-hosted monitoring."),
      getRootContents: vi.fn().mockResolvedValue([{ name: "package.json", path: "package.json", type: "file" }]),
      getLatestRelease: vi.fn().mockResolvedValue({ tagName: "v1.0.0", publishedAt: new Date("2026-05-01") }),
    });

    const discoverRepos = new DiscoverRepos(repoApiPort, makeMockAnalyzeRepo(metrics));
    const result = await discoverRepos.execute(intent, baseSearch, { top: 5 });

    expect(result.enriched).toHaveLength(1);
    const enriched = result.enriched[0];
    expect(enriched.search.fullName).toBe("acme/monitor");
    expect(enriched.readme).toContain("Self-hosted monitoring");
    expect(enriched.rootContents).toEqual([{ name: "package.json", path: "package.json", type: "file" }]);
    expect(enriched.latestRelease?.tagName).toBe("v1.0.0");
    expect(enriched.metrics).toEqual(metrics);
    expect(enriched.analysisError).toBeNull();
  });

  it("records analysisError when metrics analysis fails, without losing other enrichment data", async () => {
    const intent = parseIntent("monitoring");
    const repoApiPort = makeMockRepoApiPort({
      searchRepos: vi.fn().mockResolvedValue([makeRepo("acme/monitor")]),
      getReadme: vi.fn().mockResolvedValue("readme text"),
    });
    const failingAnalyzeRepo = { execute: vi.fn().mockRejectedValue(new Error("rate limited")) } as unknown as AnalyzeRepo;

    const discoverRepos = new DiscoverRepos(repoApiPort, failingAnalyzeRepo);
    const result = await discoverRepos.execute(intent, baseSearch, { top: 5 });

    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].metrics).toBeNull();
    expect(result.enriched[0].analysisError).toContain("rate limited");
    expect(result.enriched[0].readme).toBe("readme text");
  });

  it("bounds enrichment to a preselected pool smaller than the raw candidate count", async () => {
    const intent = parseIntent("monitoring");
    const rawRepos = Array.from({ length: 50 }, (_, i) => makeRepo(`acme/repo-${i}`, { stars: i }));

    const repoApiPort = makeMockRepoApiPort({
      searchRepos: vi.fn().mockResolvedValue(rawRepos),
    });

    const discoverRepos = new DiscoverRepos(repoApiPort, makeMockAnalyzeRepo());
    const result = await discoverRepos.execute(intent, baseSearch, { top: 5 });

    expect(result.stage1Raw).toHaveLength(50);
    expect(result.enriched.length).toBeLessThan(50);
    expect(repoApiPort.getReadme).toHaveBeenCalledTimes(result.enriched.length);
  });

  it("stops issuing search calls once the merged pool reaches the 200-result cap", async () => {
    const intent = parseIntent("self-hosted monitoring dashboard for apis and websites");
    const bigBatch = Array.from({ length: 200 }, (_, i) => makeRepo(`acme/repo-${i}`));
    const searchRepos = vi.fn().mockResolvedValue(bigBatch);
    const repoApiPort = makeMockRepoApiPort({ searchRepos });

    const discoverRepos = new DiscoverRepos(repoApiPort, makeMockAnalyzeRepo());
    await discoverRepos.execute(intent, baseSearch, { top: 5 });

    expect(searchRepos).toHaveBeenCalledTimes(1);
  });
});
