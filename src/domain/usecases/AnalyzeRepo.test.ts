import { describe, expect, it, vi } from "vitest";
import { AnalyzeRepo } from "./AnalyzeRepo.js";
import type { RepoApiPort } from "../../ports/RepoApiPort.js";
import type { MetricsRepoPort } from "../../ports/MetricsRepoPort.js";
import type { RepoIntelligencePort } from "../../ports/RepoIntelligencePort.js";
import type { Repo } from "../entities/Repo.js";

function makeRepoData(overrides: Partial<Repo> = {}): Repo {
  return {
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
    description: "A widget",
    stars: 1000,
    forks: 50,
    archived: false,
    isFork: false,
    openIssues: 4,
    defaultBranch: "main",
    pushedAt: new Date("2026-06-01"),
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeMockRepoApiPort(overrides: Partial<RepoApiPort> = {}): RepoApiPort {
  return {
    getRepo: vi.fn().mockResolvedValue(makeRepoData()),
    getLanguages: vi.fn().mockResolvedValue({ TypeScript: 1000 }),
    getIssues: vi.fn().mockResolvedValue(4),
    getContributors: vi.fn().mockResolvedValue(10),
    getReadme: vi.fn(),
    getRootContents: vi.fn(),
    getLatestRelease: vi.fn(),
    searchRepos: vi.fn(),
    ...overrides,
  };
}

function makeMockMetricsRepoPort(): MetricsRepoPort {
  return {
    saveMetrics: vi.fn().mockResolvedValue(undefined),
    getMetrics: vi.fn().mockResolvedValue(null),
    getTrending: vi.fn(),
  };
}

function makeMockIntelligencePort(): RepoIntelligencePort {
  return {
    saveSnapshot: vi.fn().mockResolvedValue(undefined),
    saveHealthScore: vi.fn().mockResolvedValue(undefined),
  };
}

describe("AnalyzeRepo.execute persistence", () => {
  it("writes a snapshot with the fetched repo data, leaving release fields null", async () => {
    const repoApiPort = makeMockRepoApiPort({ getRepo: vi.fn().mockResolvedValue(makeRepoData({ stars: 5000, forks: 200 })) });
    const repoIntelligencePort = makeMockIntelligencePort();
    const analyzeRepo = new AnalyzeRepo(repoApiPort, makeMockMetricsRepoPort(), repoIntelligencePort);

    await analyzeRepo.execute("acme", "widget", false);

    expect(repoIntelligencePort.saveSnapshot).toHaveBeenCalledWith({
      fullName: "acme/widget",
      stars: 5000,
      forks: 200,
      openIssues: 4,
      pushedAt: new Date("2026-06-01"),
      releasedAt: null,
      releaseTag: null,
    });
  });

  it("uses the verified open-issue count from a deep analysis, not the search-cached one", async () => {
    const repoApiPort = makeMockRepoApiPort({
      getRepo: vi.fn().mockResolvedValue(makeRepoData({ openIssues: 4 })),
      getIssues: vi.fn().mockResolvedValue(42),
    });
    const repoIntelligencePort = makeMockIntelligencePort();
    const analyzeRepo = new AnalyzeRepo(repoApiPort, makeMockMetricsRepoPort(), repoIntelligencePort);

    await analyzeRepo.execute("acme", "widget", true);

    expect(repoIntelligencePort.saveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ openIssues: 42 })
    );
  });

  it("still returns metrics when the snapshot write fails", async () => {
    const repoIntelligencePort = makeMockIntelligencePort();
    (repoIntelligencePort.saveSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const analyzeRepo = new AnalyzeRepo(makeMockRepoApiPort(), makeMockMetricsRepoPort(), repoIntelligencePort);
    const metrics = await analyzeRepo.execute("acme", "widget", false);

    expect(metrics.repoOwner).toBe("acme");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
