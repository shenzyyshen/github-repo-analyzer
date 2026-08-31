import { describe, expect, it, vi } from "vitest";
import { AnalyzeRepoDeep, parseScoutSelectionContext } from "./AnalyzeRepoDeep.js";
import type { AnalyzeRepo } from "./AnalyzeRepo.js";
import type { RepoApiPort } from "../../ports/RepoApiPort.js";
import type { ReportWriterPort } from "../../ports/ReportWriterPort.js";
import type { SearchResult } from "../entities/SearchResult.js";
import type { Repo } from "../entities/Repo.js";
import type { Metrics } from "../entities/Metrics.js";

const scoutTable = [
  "# Repo Scout Results",
  "",
  "## Shortlist",
  "",
  "| Repo | Score | Best For | Why Recommended | Tradeoff | Risk | Stars | Forks | Contributors | Age | Language | Last Commit |",
  "| --- | ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |",
  "| acme/widget | 8 | monitoring | strong prompt fit and active maintenance | fewer stars than alternatives | — | 1,000 | 50 | 12 | 2 years | TypeScript | 2026-01-01 |",
  "| acme/other | 5 | fallback | broader match | — | — | 200 | 10 | 3 | 1 year | Go | 2025-06-01 |",
].join("\n");

describe("parseScoutSelectionContext", () => {
  it("finds the matching repo row and parses its score and rationale", () => {
    const result = parseScoutSelectionContext(scoutTable, "acme/widget");
    expect(result).toEqual({
      whyRecommended: "strong prompt fit and active maintenance",
      score: 8,
    });
  });

  it("returns null when the repo isn't in the table", () => {
    expect(parseScoutSelectionContext(scoutTable, "acme/missing")).toBeNull();
  });

  it("returns a null score when the score column isn't numeric", () => {
    const table = scoutTable.replace("| acme/widget | 8 |", "| acme/widget | n/a |");
    const result = parseScoutSelectionContext(table, "acme/widget");
    expect(result?.score).toBeNull();
  });
});

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
    description: "A self-hosted widget",
    stars: 1000,
    forks: 50,
    archived: false,
    isFork: false,
    language: "TypeScript",
    createdAt: new Date("2024-01-01"),
    pushedAt: new Date("2026-06-01"),
    topics: [],
    ...overrides,
  };
}

function makeRepoData(overrides: Partial<Repo> = {}): Repo {
  return {
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
    description: "A self-hosted widget",
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

function makeMetrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    repoOwner: "acme",
    repoName: "widget",
    stars: 1000,
    starGrowth24h: "+10 (1%)",
    languages: { TypeScript: 5000 },
    openIssues: 4,
    contributors: 12,
    lastCommit: new Date("2026-06-01"),
    analyzedAt: new Date("2026-07-01"),
    ...overrides,
  };
}

function makeMockRepoApiPort(overrides: Partial<RepoApiPort> = {}): RepoApiPort {
  return {
    getRepo: vi.fn().mockResolvedValue(makeRepoData()),
    getLanguages: vi.fn().mockResolvedValue({ TypeScript: 5000 }),
    getIssues: vi.fn().mockResolvedValue(4),
    getContributors: vi.fn().mockResolvedValue(12),
    getReadme: vi.fn().mockResolvedValue("# Widget\nA self-hosted widget with install and usage docs."),
    getRootContents: vi.fn().mockResolvedValue([{ name: "package.json", path: "package.json", type: "file" }]),
    getLatestRelease: vi.fn().mockResolvedValue({ tagName: "v1.0.0", publishedAt: new Date("2026-05-01") }),
    searchRepos: vi.fn(),
    ...overrides,
  };
}

function makeMockAnalyzeRepo(metrics: Metrics = makeMetrics()): AnalyzeRepo {
  return { execute: vi.fn().mockResolvedValue(metrics) } as unknown as AnalyzeRepo;
}

function makeMockReportWriterPort(scoutReport: string | null = null): ReportWriterPort {
  return {
    writeAnalysisReport: vi.fn().mockResolvedValue(undefined),
    writeScoutReport: vi.fn().mockResolvedValue(undefined),
    readScoutReport: vi.fn().mockResolvedValue(scoutReport),
  };
}

describe("AnalyzeRepoDeep.execute", () => {
  it("builds a full RepoContext from the repo API and analyze use case", async () => {
    const repoApiPort = makeMockRepoApiPort();
    const analyzeRepo = makeMockAnalyzeRepo();
    const reportWriterPort = makeMockReportWriterPort();

    const useCase = new AnalyzeRepoDeep(repoApiPort, analyzeRepo, reportWriterPort);
    const context = await useCase.execute(makeSearchResult());

    expect(context.repoData.fullName).toBe("acme/widget");
    expect(context.contributors).toBe(12);
    expect(context.verifiedOpenIssues).toBe(4);
    expect(context.latestRelease?.tagName).toBe("v1.0.0");
    expect(analyzeRepo.execute).toHaveBeenCalledWith("acme", "widget", true);
  });

  it("writes an analysis report that includes scout context when a prior scout report exists", async () => {
    const reportWriterPort = makeMockReportWriterPort(scoutTable);
    const useCase = new AnalyzeRepoDeep(makeMockRepoApiPort(), makeMockAnalyzeRepo(), reportWriterPort);

    await useCase.execute(makeSearchResult());

    expect(reportWriterPort.writeAnalysisReport).toHaveBeenCalledTimes(1);
    const content = (reportWriterPort.writeAnalysisReport as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(content).toContain("Why This Repo Was Selected");
    expect(content).toContain("strong prompt fit and active maintenance");
  });

  it("writes a report without a scout section when no prior scout report exists", async () => {
    const reportWriterPort = makeMockReportWriterPort(null);
    const useCase = new AnalyzeRepoDeep(makeMockRepoApiPort(), makeMockAnalyzeRepo(), reportWriterPort);

    await useCase.execute(makeSearchResult());

    const content = (reportWriterPort.writeAnalysisReport as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(content).not.toContain("Why This Repo Was Selected");
    expect(content).toContain("analyzed as a candidate repository");
  });

  it("flags risk when the repo has no release and shallow contributor depth", async () => {
    const repoApiPort = makeMockRepoApiPort({
      getLatestRelease: vi.fn().mockResolvedValue(null),
      getContributors: vi.fn().mockResolvedValue(1),
    });
    const analyzeRepo = makeMockAnalyzeRepo();
    const reportWriterPort = makeMockReportWriterPort();

    const useCase = new AnalyzeRepoDeep(repoApiPort, analyzeRepo, reportWriterPort);
    await useCase.execute(makeSearchResult());

    const content = (reportWriterPort.writeAnalysisReport as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(content).toContain("No GitHub release signal is present.");
    expect(content).toContain("Contributor depth is shallow");
  });
});
