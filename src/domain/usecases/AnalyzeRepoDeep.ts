import type { Metrics } from "../entities/Metrics.js";
import type { SearchResult } from "../entities/SearchResult.js";
import type { RepoApiPort, RepoReleaseInfo, RepoRootEntry } from "../../ports/RepoApiPort.js";
import type { ReportWriterPort } from "../../ports/ReportWriterPort.js";
import type { AnalyzeRepo } from "./AnalyzeRepo.js";

export type RepoContext = {
  repo: SearchResult;
  metrics: Metrics;
  repoData: {
    fullName: string;
    description: string | null;
    defaultBranch: string;
    forks: number;
    openIssues: number;
    createdAt: Date;
    pushedAt: Date;
  };
  languages: Record<string, number>;
  contributors: number;
  verifiedOpenIssues: number;
  readme: string | null;
  rootContents: RepoRootEntry[];
  latestRelease: RepoReleaseInfo | null;
};

export type ScoutSelectionContext = {
  whyRecommended: string;
  score: number | null;
};

function buildRepoUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

function buildRiskDetails(context: RepoContext): string[] {
  const risks: string[] = [];
  const ageDays = Math.floor((Date.now() - context.metrics.lastCommit.getTime()) / (24 * 60 * 60 * 1000));
  const issuePressure = context.verifiedOpenIssues / Math.max(context.metrics.stars, 1);
  const rootNames = new Set(context.rootContents.map((entry) => entry.name.toLowerCase()));
  const setupSignals =
    Number(rootNames.has("dockerfile")) +
    Number(rootNames.has("docker-compose.yml") || rootNames.has("docker-compose.yaml")) +
    Number(rootNames.has(".env.example")) +
    Number(rootNames.has("package.json") || rootNames.has("pyproject.toml") || rootNames.has("requirements.txt")) +
    Number([...rootNames].some((name) => name.startsWith(".github")));

  if (issuePressure > 0.35 && context.contributors < 5) {
    risks.push("Issue pressure looks high relative to the repo's size and contributor depth.");
  } else if (issuePressure > 0.1 && context.contributors < 3) {
    risks.push("Issue pressure is non-trivial and maintainer depth is limited.");
  }

  if (ageDays > 180) {
    risks.push("Recent maintenance activity is weak.");
  }

  if (!context.latestRelease) {
    risks.push("No GitHub release signal is present.");
  }

  if (context.contributors <= 1) {
    risks.push("Contributor depth is shallow, which increases bus-factor risk.");
  }

  if (setupSignals <= 1) {
    risks.push("Setup and operational signals are limited from the root snapshot.");
  }

  return risks;
}

function detectStackSignals(rootContents: RepoRootEntry[], readme: string | null): string[] {
  const names = new Set(rootContents.map((entry) => entry.name.toLowerCase()));
  const readmeText = readme?.toLowerCase() ?? "";
  const signals: string[] = [];

  if (names.has("package.json")) signals.push("Node.js / JavaScript or TypeScript");
  if (names.has("tsconfig.json")) signals.push("TypeScript");
  if (names.has("pyproject.toml") || names.has("requirements.txt")) signals.push("Python");
  if (names.has("go.mod")) signals.push("Go");
  if (names.has("cargo.toml")) signals.push("Rust");
  if (names.has("dockerfile")) signals.push("Docker");
  if (names.has("docker-compose.yml") || names.has("docker-compose.yaml")) signals.push("Docker Compose");
  if (names.has(".env.example")) signals.push("environment-template provided");
  if ([...names].some((name) => name.startsWith(".github"))) signals.push("GitHub Actions / CI config");
  if (readmeText.includes("typescript") && !signals.includes("TypeScript")) signals.push("TypeScript");
  if (readmeText.includes("python") && !signals.includes("Python")) signals.push("Python");

  return [...new Set(signals)];
}

function buildStructureOverview(rootContents: RepoRootEntry[]): string[] {
  const names = rootContents.map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  return names.slice(0, 15);
}

function detectSetupSignals(rootContents: RepoRootEntry[], readme: string | null): string[] {
  const names = new Set(rootContents.map((entry) => entry.name.toLowerCase()));
  const signals: string[] = [];

  if (readme && readme.length > 300) signals.push("README has meaningful setup/documentation content");
  if (names.has("dockerfile")) signals.push("Docker setup present");
  if (names.has("docker-compose.yml") || names.has("docker-compose.yaml")) signals.push("docker-compose present");
  if (names.has("makefile")) signals.push("Makefile present");
  if (names.has(".env.example")) signals.push(".env.example present");
  if ([...names].some((name) => name.startsWith(".github"))) signals.push("CI/workflow config present");

  return signals;
}

/**
 * Parses a repo's row out of a previously written scout-results markdown
 * table, if present. Pure text parsing — the file read itself goes through
 * ReportWriterPort.
 */
export function parseScoutSelectionContext(
  scoutReportContent: string,
  repoFullName: string
): ScoutSelectionContext | null {
  const lines = scoutReportContent.split("\n");

  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    if (line.includes("Repo | Score | Best For")) continue;
    if (line.includes("---")) continue;

    const columns = line
      .split("|")
      .slice(1, -1)
      .map((part) => part.trim());

    if (columns.length < 8) continue;
    if (columns[0] !== repoFullName) continue;

    const score = Number(columns[1]);
    return {
      whyRecommended: columns[3],
      score: Number.isNaN(score) ? null : score,
    };
  }

  return null;
}

function buildAnalysisReportMarkdown(context: RepoContext, scoutContext: ScoutSelectionContext | null): string {
  const languageLines = Object.entries(context.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([name, bytes]) => `- ${name}: ${bytes.toLocaleString()}`)
    .join("\n");
  const stackSignals = detectStackSignals(context.rootContents, context.readme);
  const structureOverview = buildStructureOverview(context.rootContents);
  const setupSignals = detectSetupSignals(context.rootContents, context.readme);
  const readmeSnippet = context.readme
    ? context.readme
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(" ")
        .slice(0, 500)
    : null;
  const latestReleaseLine = context.latestRelease
    ? `- Latest Release: ${context.latestRelease.tagName} (${context.latestRelease.publishedAt.toISOString()})`
    : "- Latest Release: none detected";
  const riskDetails = buildRiskDetails(context);
  const repoUrl = buildRepoUrl(context.repoData.fullName);
  const analysisHeadline = scoutContext
    ? `${context.repoData.fullName} was shortlisted because the scout identified it as a strong candidate for this request, with particular emphasis on: ${scoutContext.whyRecommended}.`
    : `${context.repoData.fullName} was analyzed as a candidate repository based on its GitHub metadata, structure signals, and README content.`;
  const firstImpression = [
    context.repoData.description ?? null,
    stackSignals.length > 0 ? `Likely stack: ${stackSignals.join(", ")}.` : null,
    setupSignals.length > 0 ? `Setup quality signals: ${setupSignals.slice(0, 3).join(", ")}.` : null,
    context.latestRelease ? `A GitHub release exists (${context.latestRelease.tagName}), which is a useful maturity signal.` : "No GitHub release was detected from the current snapshot.",
  ]
    .filter(Boolean)
    .join(" ");
  const selectionReasons = scoutContext
    ? [
        `- Scout score: ${scoutContext.score !== null ? `${scoutContext.score}/10` : "not available"}`,
        `- Scout rationale: ${scoutContext.whyRecommended}`,
        `- Current repo description: ${context.repoData.description ?? "No description provided"}`,
        `- README support: ${readmeSnippet ?? "README unavailable"}`,
      ].join("\n")
    : null;

  const selectedSection = scoutContext
    ? [
        "## Why This Repo Was Selected",
        "",
        selectionReasons,
        "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const concernsSection =
    scoutContext && scoutContext.score !== null && scoutContext.score < 7
      ? [
          "## Scout Concerns",
          "",
          `The scout scored this repo ${scoutContext.score}/10, so review it with extra attention to the trade-offs implied by: ${scoutContext.whyRecommended}.`,
          "",
        ].join("\n")
      : "";

  const focusSection = scoutContext
    ? [
        "## Analysis Focus",
        "",
        `This analysis emphasizes the areas highlighted by the scout: ${scoutContext.whyRecommended}.`,
        "",
      ].join("\n")
    : "";

  return [
    "# Repo Analysis",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Analysis Summary",
    "",
    analysisHeadline,
    "",
    "## First Impression",
    "",
    firstImpression,
    "",
    selectedSection,
    concernsSection,
    focusSection,
    "## Project Summary",
    "",
    `${context.repoData.fullName} is a ${context.repo.language ?? "software"} repository with ${context.metrics.stars.toLocaleString()} stars and ${context.contributors.toLocaleString()} contributors.`,
    context.repoData.description ?? "No description provided.",
    "",
    "## Tech Stack Signals",
    "",
    ...(stackSignals.length > 0 ? stackSignals.map((signal) => `- ${signal}`) : ["- No strong stack signal detected from root files"]),
    "",
    "## Structure Overview",
    "",
    ...(structureOverview.length > 0 ? structureOverview.map((entry) => `- ${entry}`) : ["- Root contents unavailable"]),
    "",
    "## Setup Quality Signals",
    "",
    ...(setupSignals.length > 0 ? setupSignals.map((signal) => `- ${signal}`) : ["- No obvious setup-quality signals detected"]),
    "",
    "## Risks",
    "",
    ...(riskDetails.length > 0 ? riskDetails.map((risk) => `- ${risk}`) : ["- No major structural or maintenance risk stood out from the current snapshot."]),
    "",
    "## README Snapshot",
    "",
    readmeSnippet ?? "README unavailable.",
    "",
    "## Repository Metadata",
    "",
    `- Repo: ${context.repoData.fullName}`,
    `- GitHub URL: ${repoUrl}`,
    `- Default Branch: ${context.repoData.defaultBranch}`,
    `- Created At: ${context.repoData.createdAt.toISOString()}`,
    `- Last Push: ${context.repoData.pushedAt.toISOString()}`,
    `- Forks: ${context.repoData.forks.toLocaleString()}`,
    latestReleaseLine,
    "",
    "## Metrics Snapshot",
    "",
    `- Stars: ${context.metrics.stars.toLocaleString()}`,
    `- 24h Growth: ${context.metrics.starGrowth24h}`,
    `- Open Issues: ${context.verifiedOpenIssues.toLocaleString()}`,
    `- Contributors: ${context.contributors.toLocaleString()}`,
    `- Last Commit: ${context.metrics.lastCommit.toISOString()}`,
    "",
    "## Language Breakdown",
    "",
    languageLines || "- No language data available",
    "",
  ].join("\n");
}

/**
 * Use case: deep-dive analysis of a single selected repo. Fetches full
 * GitHub context, correlates it with why the repo was shortlisted (if a
 * prior scout report exists), and writes a markdown analysis report.
 */
export class AnalyzeRepoDeep {
  constructor(
    private readonly repoApiPort: RepoApiPort,
    private readonly analyzeRepo: AnalyzeRepo,
    private readonly reportWriterPort: ReportWriterPort
  ) {}

  async execute(repo: SearchResult): Promise<RepoContext> {
    const [metrics, repoData, languages, contributors, verifiedOpenIssues, readme, rootContents, latestRelease] = await Promise.all([
      this.analyzeRepo.execute(repo.owner, repo.name, true),
      this.repoApiPort.getRepo(repo.owner, repo.name),
      this.repoApiPort.getLanguages(repo.owner, repo.name),
      this.repoApiPort.getContributors(repo.owner, repo.name),
      this.repoApiPort.getIssues(repo.owner, repo.name),
      this.repoApiPort.getReadme(repo.owner, repo.name),
      this.repoApiPort.getRootContents(repo.owner, repo.name),
      this.repoApiPort.getLatestRelease(repo.owner, repo.name),
    ]);

    const context: RepoContext = {
      repo,
      metrics,
      repoData: {
        fullName: repoData.fullName,
        description: repoData.description,
        defaultBranch: repoData.defaultBranch,
        forks: repoData.forks,
        openIssues: repoData.openIssues,
        createdAt: repoData.createdAt,
        pushedAt: repoData.pushedAt,
      },
      languages,
      contributors,
      verifiedOpenIssues,
      readme,
      rootContents,
      latestRelease,
    };

    const scoutReportContent = await this.reportWriterPort.readScoutReport();
    const scoutContext = scoutReportContent
      ? parseScoutSelectionContext(scoutReportContent, context.repoData.fullName)
      : null;

    await this.reportWriterPort.writeAnalysisReport(buildAnalysisReportMarkdown(context, scoutContext));

    return context;
  }
}
