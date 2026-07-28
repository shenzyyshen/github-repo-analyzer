#!/usr/bin/env node
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { GithubAdapter } from "../adapters/github/GithubAdapter.js";
import { PrismaAdapter } from "../adapters/database/PrismaAdapter.js";
import { FileSessionStore } from "../adapters/session/FileSessionStore.js";
import { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import type { Metrics } from "../domain/entities/Metrics.js";
import type { SearchResult } from "../domain/entities/SearchResult.js";
import type { SeenRepoEntry, ShortlistHistoryEntry } from "../domain/entities/SessionState.js";
import type { RepoReleaseInfo, RepoRootEntry } from "../ports/RepoApiPort.js";
import {
  buildRetrievalQueries,
  buildClarificationPrompt,
  createSessionPreferences,
  inferFilters,
  normalizeSearchQuery,
  type ClarifyingQuestion,
  type ParsedIntent,
  renderAppliedFilters,
  shouldClarifyBeforeSearch,
  type SessionPreferences,
} from "../domain/usecases/ParseIntent.js";
import { buildSeenEntries, renderSeenRepos, renderShortlistHistory } from "../domain/usecases/ManageSession.js";
import type { RankedRepo } from "../domain/usecases/ScoreAndRank.js";
import { runStagedSearch, type StagedSearchResult } from "./stagedSearch.js";

type Role = "user" | "assistant";

type Turn = {
  role: Role;
  content: string;
};

type RepoContext = {
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

type ScoutSelectionContext = {
  whyRecommended: string;
  score: number | null;
};

type SearchPlan = {
  action: "search" | "clarify" | "exit";
  reply: string;
  followUp: string | null;
  search: {
    query: string;
    language: string | null;
    minStars: number;
    since: string | null;
    license: string | null;
    sort: "stars" | "updated" | "forks";
    top: number;
    random: boolean;
  } | null;
};

type AnalyzedRepo = {
  search: SearchResult;
  metrics: Metrics | null;
  error: string | null;
  readme: string | null;
  rootContents: RepoRootEntry[];
  latestRelease: RepoReleaseInfo | null;
};

type RankedShortlistItem = {
  item: AnalyzedRepo;
  score: number;
  bestFor: string;
  why: string;
  tradeoff: string | null;
  risk: string | null;
  fitType: "direct match" | "production choice" | "adaptable framework" | "niche option" | "balanced option";
};

type SelectionChoice =
  | { kind: "pick"; index: number }
  | { kind: "none" }
  | { kind: "rerun" }
  | { kind: "new" }
  | { kind: "seen" }
  | { kind: "history" }
  | { kind: "back" }
  | { kind: "exit" };

type TextChoice =
  | { kind: "text"; value: string }
  | { kind: "back" }
  | { kind: "exit" };

const INVALID_SELECTION_MESSAGE = "Enter a number, or type 're run', 'new', 'none', 'seen', 'history', or 'quit'.";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function buildGitHubQuery(search: NonNullable<SearchPlan["search"]>): string {
  // Qualifiers like `stars:>500 pushed:>2025-04-12 language:X` can take ~60 chars.
  // GitHub enforces a 256-char limit on the full query string.
  const MAX_QUERY_TERMS = 180;
  const trimmedQuery = search.query.length > MAX_QUERY_TERMS
    ? search.query
        .split(" ")
        .reduce((acc: string[], term) => {
          if ((acc.join(" ") + " " + term).length <= MAX_QUERY_TERMS) acc.push(term);
          return acc;
        }, [])
        .join(" ")
    : search.query;

  const parts: string[] = [trimmedQuery];
  if (search.language) parts.push(`language:${search.language}`);
  if (search.minStars > 0) parts.push(`stars:>${search.minStars}`);
  if (search.since) parts.push(`pushed:>${search.since}`);
  if (search.license) parts.push(`license:${search.license}`);
  return parts.join(" ");
}

function summarizeResults(results: AnalyzedRepo[]): string {
  if (results.length === 0) {
    return "No repositories were found.";
  }

  return results
    .map((item, index) => {
      if (item.error) {
        return `${index + 1}. ${item.search.fullName} - error: ${item.error}`;
      }

      const metrics = item.metrics;
      const language = item.search.language ?? "unknown";
      const growth = metrics?.starGrowth24h ?? "N/A";
      const issues = metrics?.openIssues ?? item.search.stars;
      return [
        `${index + 1}. ${item.search.fullName}`,
        `stars=${item.search.stars}`,
        `language=${language}`,
        `growth=${growth}`,
        `open_issues=${issues}`,
        `description=${item.search.description ?? "none"}`,
      ].join(" | ");
    })
    .join("\n");
}

function getLastCommit(item: AnalyzedRepo): Date {
  return item.metrics?.lastCommit ?? item.search.pushedAt;
}

function getPrimaryLanguage(item: AnalyzedRepo): string {
  if (item.metrics) {
    const entries = Object.entries(item.metrics.languages);
    if (entries.length > 0) {
      entries.sort((a, b) => b[1] - a[1]);
      return entries[0][0];
    }
  }
  return item.search.language ?? "unknown";
}

function buildRepoUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

function getRepoAgeDays(item: AnalyzedRepo): number {
  return Math.max(
    1,
    Math.floor((Date.now() - item.search.createdAt.getTime()) / (24 * 60 * 60 * 1000))
  );
}

function getRepoAgeLabel(item: AnalyzedRepo): string {
  const days = getRepoAgeDays(item);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function getContributorCount(item: AnalyzedRepo): number {
  return item.metrics?.contributors ?? 0;
}

function buildRiskSummary(item: AnalyzedRepo): string | null {
  const ageDays = Math.floor((Date.now() - getLastCommit(item).getTime()) / (24 * 60 * 60 * 1000));
  const contributors = getContributorCount(item);
  const stars = item.search.stars;
  const openIssues = item.metrics?.openIssues ?? 0;
  const issuePressure = openIssues / Math.max(stars, 1);
  const rootNames = new Set(item.rootContents.map((entry) => entry.name.toLowerCase()));
  const setupSignals =
    Number(rootNames.has("dockerfile")) +
    Number(rootNames.has("docker-compose.yml") || rootNames.has("docker-compose.yaml")) +
    Number(rootNames.has(".env.example")) +
    Number(rootNames.has("package.json") || rootNames.has("pyproject.toml") || rootNames.has("requirements.txt")) +
    Number([...rootNames].some((name) => name.startsWith(".github")));

  if (item.error) {
    return "DB offline — metrics shown from search data only";
  }
  if (issuePressure > 0.35 && contributors < 5) {
    return "issue pressure looks high relative to repo size and maintainer depth";
  }
  if (ageDays > 180) {
    return "maintenance risk: not recently active";
  }
  if (!item.latestRelease && stars >= 1000) {
    return "release risk: no clear release signal despite meaningful adoption";
  }
  if (contributors <= 1 && stars < 250) {
    return "adoption risk: low contributor depth";
  }
  if (setupSignals <= 1) {
    return "setup risk: weak operational/setup signals from the root snapshot";
  }
  if (item.search.stars < 25) {
    return "adoption risk: low external validation signal";
  }

  return null;
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

function buildShortlistNames(results: Array<AnalyzedRepo | RankedShortlistItem>): string {
  const unwrap = (entry: AnalyzedRepo | RankedShortlistItem) => ("item" in entry ? entry.item : entry);
  const successful = results
    .map(unwrap)
    .filter((item) => !item.error)
    .slice(0, 3)
    .map((item) => item.search.fullName);

  if (successful.length > 0) {
    return successful.join(", ");
  }

  return results
    .map(unwrap)
    .slice(0, 3)
    .map((item) => item.search.fullName)
    .join(", ");
}

async function writeScoutReport(results: RankedShortlistItem[], summary: string): Promise<void> {
  await mkdir("reports", { recursive: true });

  const timestamp = new Date().toISOString();
  const header = `# Repo Scout Results\n\nGenerated: ${timestamp}\n`;
  const tableHeader = [
    "| Repo | Score | Best For | Why Recommended | Tradeoff | Risk | Stars | Forks | Contributors | Age | Language | Last Commit |",
    "| --- | ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |",
  ];
  const rows = results.map((ranked) => {
    const { item } = ranked;
    const repo = item.search.fullName;
    const stars = item.search.stars.toLocaleString();
    const forks = item.search.forks.toLocaleString();
    const contributors = getContributorCount(item).toLocaleString();
    const age = getRepoAgeLabel(item);
    const language = getPrimaryLanguage(item);
    const lastCommit = getLastCommit(item).toISOString().slice(0, 10);
    return `| ${repo} | ${ranked.score} | ${ranked.bestFor} | ${ranked.why} | ${ranked.tradeoff ?? "—"} | ${ranked.risk ?? "—"} | ${stars} | ${forks} | ${contributors} | ${age} | ${language} | ${lastCommit} |`;
  });

  const content = [
    header,
    "## Shortlist",
    "",
    ...tableHeader,
    ...rows,
    "",
    "## Summary",
    "",
    summary.trim(),
    "",
  ].join("\n");

  await writeFile("reports/REPO_SCOUT_RESULTS.md", content, "utf8");
}

// ---------------------------------------------------------------------------
// Staged-engine adapter
// Converts the staged pipeline's RankedRepo into the RankedShortlistItem shape
// the conversational selection/render/report loop already understands.
// This is the seam that lets the agent reuse the same ranking as the CLI.
// ---------------------------------------------------------------------------

const ARTIFACT_BEST_FOR: Record<ArtifactType, string> = {
  framework: "Teams building on top of a framework",
  library: "Embedding into a larger codebase",
  cli: "A terminal-first workflow",
  tool: "A ready-to-use tool",
  dataset: "Evaluation or benchmarking data",
  boilerplate: "Starting a new project fast",
  "tips-content": "Learning and reference material",
};

function fitTypeFor(entry: RankedRepo): RankedShortlistItem["fitType"] {
  if (entry.promptFit >= 0.75) return "direct match";
  if (entry.ownerTier === "Elite" || entry.ownerTier === "Strong") return "production choice";
  if (entry.artifactType === "framework") return "adaptable framework";
  if (entry.artifactType === "library") return "niche option";
  return "balanced option";
}

function stagedToShortlist(result: StagedSearchResult): RankedShortlistItem[] {
  return result.results.map((entry) => {
    const item: AnalyzedRepo = {
      search: entry.repo,
      metrics: entry.metrics,
      error: null,
      readme: entry.readme,
      rootContents: [],
      latestRelease: entry.latestRelease,
    };
    const risk =
      [entry.note, entry.decay === "Fading" || entry.decay === "Slowing" ? `Momentum: ${entry.decay}` : null]
        .filter(Boolean)
        .join(" · ") || null;
    return {
      item,
      score: Math.round(entry.finalScore * 100),
      bestFor: ARTIFACT_BEST_FOR[entry.artifactType] ?? "General use",
      why: entry.whyThisRepo,
      tradeoff: entry.alternativesNote,
      risk,
      fitType: fitTypeFor(entry),
    } satisfies RankedShortlistItem;
  });
}

type ArtifactType = RankedRepo["artifactType"];

function renderShortlist(results: RankedShortlistItem[]): string {
  const HR = chalk.dim("  " + "─".repeat(60));
  const lbl = (s: string) => chalk.dim(s.padEnd(11));
  const DOT = chalk.dim("  ·  ");

  const blocks = results.map((ranked, index) => {
    const { item } = ranked;
    const caution = buildRiskSummary(item);
    const stars = item.search.stars.toLocaleString();
    const forks = item.search.forks.toLocaleString();
    const contributors = getContributorCount(item).toLocaleString();
    const lastCommitDate = getLastCommit(item);
    const lastCommit = lastCommitDate.toISOString().slice(0, 10);
    const isStale = Date.now() - lastCommitDate.getTime() > 6 * 30 * 24 * 60 * 60 * 1000;
    const lastCommitColored = isStale ? chalk.red(lastCommit) : chalk.green(lastCommit);
    const language = getPrimaryLanguage(item);
    const pad = "       ";

    const rows: (string | null)[] = [
      `  ${chalk.cyan.bold(`${index + 1}.`)}  ${chalk.bold.white(item.search.fullName)}${language ? chalk.dim(`  [${language}]`) : ""}`,
      item.search.description ? `${pad}${chalk.dim(item.search.description)}` : null,
      "",
      `${pad}${lbl("Best for")} ${ranked.bestFor}`,
      `${pad}${lbl("Why")} ${ranked.why}`,
      ranked.tradeoff ? `${pad}${lbl("Tradeoff")} ${ranked.tradeoff}` : null,
      caution ? `${pad}${lbl("Caution")} ${chalk.yellow(`⚠  ${caution}`)}` : null,
      "",
      `${pad}${chalk.yellow("★")} ${chalk.yellow(stars)} stars${DOT}${forks} forks${DOT}${contributors} contributors`,
      `${pad}Last updated ${lastCommitColored}${DOT}Language ${language ?? "—"}`,
      `${pad}${chalk.blue.underline(buildRepoUrl(item.search.fullName))}`,
    ];

    return rows.filter((r): r is string => r !== null).join("\n");
  });

  return `\n${HR}\n${blocks.join(`\n\n${HR}\n`)}\n\n${HR}\n`;
}

async function promptForSelection(
  rl: ReturnType<typeof createInterface>,
  max: number
): Promise<SelectionChoice> {
  while (true) {
    const selection = (
      await rl.question(
        `${chalk.dim("Pick a number to dive deeper —")} ${chalk.cyan("re run")} ${chalk.dim("to search again with feedback,")} ${chalk.cyan("new")} ${chalk.dim("for a fresh prompt,")} ${chalk.cyan("none")} ${chalk.dim("to refine.")}\n> `
      )
    )
      .trim()
      .toLowerCase();

    if (selection === "exit" || selection === "quit") {
      output.write("Goodbye.\n");
      return { kind: "exit" };
    }

    if (selection === "back") {
      return { kind: "back" };
    }

    if (selection === "none") {
      return { kind: "none" };
    }

    if (selection === "re run" || selection === "rerun") {
      return { kind: "rerun" };
    }

    if (selection === "new") {
      return { kind: "new" };
    }

    if (selection === "seen") {
      return { kind: "seen" };
    }

    if (selection === "history") {
      return { kind: "history" };
    }

    const index = Number(selection);
    if (Number.isInteger(index) && index >= 1 && index <= max) {
      return { kind: "pick", index: index - 1 };
    }

    output.write(`${INVALID_SELECTION_MESSAGE}\n`);
  }
}

async function promptForRefinement(
  rl: ReturnType<typeof createInterface>
): Promise<TextChoice> {
  while (true) {
    const refinement = (await rl.question("What would you like to change about the search?\n> ")).trim();

    if (refinement === "exit" || refinement === "quit") {
      output.write("Goodbye.\n");
      return { kind: "exit" };
    }

    if (refinement === "back") {
      return { kind: "back" };
    }

    if (refinement) {
      return { kind: "text", value: refinement };
    }

    output.write(INVALID_SELECTION_MESSAGE + "\n");
  }
}

async function promptAfterAnalysis(
  rl: ReturnType<typeof createInterface>
): Promise<TextChoice> {
  while (true) {
    const nextStep = (
      await rl.question("What next? Type 'back' to return to the shortlist, or enter a new search.\n> ")
    ).trim();

    if (nextStep === "exit" || nextStep === "quit") {
      output.write("Goodbye.\n");
      return { kind: "exit" };
    }

    if (nextStep === "back") {
      return { kind: "back" };
    }

    if (nextStep) {
      return { kind: "text", value: nextStep };
    }

    output.write(INVALID_SELECTION_MESSAGE + "\n");
  }
}

async function buildRepoContext(
  githubAdapter: GithubAdapter,
  analyzeRepo: AnalyzeRepo,
  repo: SearchResult
): Promise<RepoContext> {
  const [metrics, repoData, languages, contributors, verifiedOpenIssues, readme, rootContents, latestRelease] = await Promise.all([
    analyzeRepo.execute(repo.owner, repo.name, true),
    githubAdapter.getRepo(repo.owner, repo.name),
    githubAdapter.getLanguages(repo.owner, repo.name),
    githubAdapter.getContributors(repo.owner, repo.name),
    githubAdapter.getIssues(repo.owner, repo.name),
    githubAdapter.getReadme(repo.owner, repo.name),
    githubAdapter.getRootContents(repo.owner, repo.name),
    githubAdapter.getLatestRelease(repo.owner, repo.name),
  ]);

  return {
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

async function loadScoutSelectionContext(
  repoFullName: string
): Promise<ScoutSelectionContext | null> {
  try {
    const content = await readFile("reports/REPO_SCOUT_RESULTS.md", "utf8");
    const lines = content.split("\n");

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
  } catch {
    return null;
  }
}

async function writeAnalysisReport(context: RepoContext): Promise<void> {
  await mkdir("reports", { recursive: true });
  const scoutContext = await loadScoutSelectionContext(context.repoData.fullName);

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

  const content = [
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

  await writeFile("reports/REPO_ANALYSIS.md", content, "utf8");
}

class AiBrain {
  private readonly openaiClient: OpenAI | null;
  private readonly openaiModel: string;
  private readonly claudeKey: string | null;
  private readonly claudeModel: string;

  constructor() {
    const openaiKey = process.env.OPENAI_API_KEY ?? null;
    this.openaiClient = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;
    this.openaiModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    this.claudeKey = process.env.CLAUDE_API_KEY ?? null;
    this.claudeModel = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514";
  }

  async plan(history: Turn[], userInput: string): Promise<SearchPlan> {
    const historyText = history
      .slice(-8)
      .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
      .join("\n");

    const prompt = [
      "You are the conversational brain for a GitHub repository discovery terminal agent.",
      "Decide whether to search now, ask a clarifying question, or exit.",
      "Return JSON only with this shape:",
      '{ "action": "search"|"clarify"|"exit", "reply": string, "followUp": string|null, "search": { "query": string, "language": string|null, "minStars": number, "since": "YYYY-MM-DD"|null, "sort": "stars"|"updated"|"forks", "top": number, "random": boolean } | null }',
      "Rules:",
      "- Prefer search when the request is specific enough.",
      "- Keep top between 1 and 5.",
      "- Use null for unknown optional fields.",
      "- reply should be short and conversational.",
      "- followUp should be a single useful next question when applicable.",
      "- Default minStars to 500. Only go lower if the user explicitly accepts fewer stars.",
      "",
      "Conversation history:",
      historyText || "(none)",
      "",
      `Latest user request: ${userInput}`,
    ].join("\n");

    try {
      const raw = await this.generateText(prompt);
      return this.parsePlan(raw, userInput);
    } catch (_err) {
      return {
        action: "search",
        reply: "I could not use the AI planner, so I am running a direct GitHub search.",
        followUp: "Do you want me to narrow by language, stars, or recency next?",
        search: {
          query: normalizeSearchQuery(userInput) || userInput,
          language: null,
          minStars: 500,
          since: null,
          license: null,
          sort: "stars",
          top: 5,
          random: false,
        },
      };
    }
  }

  async respond(
    history: Turn[],
    userInput: string,
    plan: NonNullable<SearchPlan["search"]>,
    results: AnalyzedRepo[]
  ): Promise<string> {
    const prompt = [
      "You are a helpful GitHub repo discovery assistant in a terminal session.",
      "Write a short conversational response explaining the results.",
      "Mention 2-3 best matches explicitly when available.",
      "End with one follow-up question to refine the search.",
      "Do not output JSON.",
      "",
      "Conversation history:",
      history
        .slice(-8)
        .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
        .join("\n") || "(none)",
      "",
      `Latest user request: ${userInput}`,
      `GitHub query used: ${buildGitHubQuery(plan)}`,
      "Analyzed results:",
      summarizeResults(results),
    ].join("\n");

    try {
      return await this.generateText(prompt);
    } catch (_err) {
      if (results.length === 0) {
        return "I did not find a strong match for that query. Do you want to narrow by framework, stars, or recency?";
      }
      const names = buildShortlistNames(results);
      const failureCount = results.filter((item) => item.error).length;
      const failureNote =
        failureCount > 0
          ? ` Some repo analyses failed, so this shortlist is based partly on search results.`
          : "";
      return `I found a shortlist worth checking: ${names}.${failureNote} Do you want me to narrow further by framework, stars, or maintenance activity?`;
    }
  }

  async generateClarifyingQuestions(
    userInput: string,
    prefs: SessionPreferences
  ): Promise<ClarifyingQuestion[]> {
    const skipped = [...prefs.skipped].join(", ") || "none";
    const prompt = [
      "You are helping a developer find GitHub repositories.",
      "Given the user's search query, generate 2-4 short, specific clarifying questions that will meaningfully sharpen the GitHub search.",
      "Rules:",
      "- Questions must be directly relevant to this specific query — no generic filler.",
      "- Do NOT ask about things already answered in the query.",
      `- Do NOT ask about these topics (already dismissed): ${skipped}.`,
      "- Assign each question a short snake_case key from this list when it fits: freshness, maturity, tool-type, language, deploy-target, license, scale, integration, output-type. Otherwise invent a descriptive key.",
      "- Return JSON only: an array of {key: string, text: string} objects.",
      "- text should be phrased as a short direct question, no more than 15 words.",
      "",
      `User query: "${userInput}"`,
    ].join("\n");

    try {
      const raw = await this.generateText(prompt);
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start === -1 || end === -1) throw new Error("No JSON array found");
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Array<{ key: string; text: string }>;
      return parsed
        .filter((q) => q.key && q.text && !prefs.skipped.has(q.key))
        .slice(0, 4);
    } catch {
      return [];
    }
  }

  private async generateText(prompt: string): Promise<string> {
    if (this.claudeKey) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.claudeKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.claudeModel,
          max_tokens: 800,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Claude request failed: ${response.status} ${text}`);
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = data.content?.find((item) => item.type === "text")?.text?.trim();
      if (!text) {
        throw new Error("Claude response did not include text content");
      }
      return text;
    }

    if (this.openaiClient) {
      const response = await this.openaiClient.responses.create({
        model: this.openaiModel,
        input: prompt,
      });
      const text = response.output_text?.trim();
      if (!text) {
        throw new Error("OpenAI response did not include text output");
      }
      return text;
    }

    throw new Error("Missing CLAUDE_API_KEY or OPENAI_API_KEY");
  }

  private parsePlan(raw: string, userInput: string): SearchPlan {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Planner did not return JSON");
    }

    const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<SearchPlan>;
    const action = parsed.action === "clarify" || parsed.action === "exit" ? parsed.action : "search";
    const search: SearchPlan["search"] = parsed.search
      ? {
          query: parsed.search.query || userInput,
          language: parsed.search.language ?? null,
          minStars: Math.max(0, Math.min(Number(parsed.search.minStars ?? 0), 1_000_000)),
          since: parsed.search.since ?? null,
          license: null,
          sort:
            parsed.search.sort === "updated" || parsed.search.sort === "forks"
              ? parsed.search.sort
              : "stars",
          top: Math.max(1, Math.min(Number(parsed.search.top ?? 5), 5)),
          random: Boolean(parsed.search.random),
        }
      : null;

    return {
      action,
      reply: parsed.reply || "I can search GitHub for that.",
      followUp: parsed.followUp ?? null,
      search,
    };
  }
}

async function main() {
  const prisma = new PrismaClient();
  const githubAdapter = new GithubAdapter(requireEnv("GITHUB_TOKEN"));
  const prismaAdapter = new PrismaAdapter(prisma);
  const analyzeRepo = new AnalyzeRepo(githubAdapter, prismaAdapter);
  const sessionStore = new FileSessionStore();
  const brain = new AiBrain();
  const rl = createInterface({ input, output });
  const persistedSession = await sessionStore.load();
  const history: Turn[] = [];
  const rejectedRepos = new Set<string>();
  const seenRepos: SeenRepoEntry[] = [...persistedSession.seenRepos];
  const shortlistHistory: ShortlistHistoryEntry[] = [...persistedSession.shortlistHistory];
  const sessionPrefs: SessionPreferences = createSessionPreferences();
  let pendingInput: string | null = null;

  let dbAvailable = true;
  try {
    await prisma.$connect();
  } catch {
    dbAvailable = false;
  }

  output.write("\x1bc");
  output.write(chalk.bold("GitHub Repo Scout") + " — what are you looking for?\n");
  if (!dbAvailable) {
    output.write(chalk.yellow("⚠  Database offline — running without metrics cache. Results shown from GitHub search only.\n"));
  }
  output.write("\n");

  try {
    outer: while (true) {
      const userInput: string = pendingInput ?? (await rl.question("> ")).trim();
      pendingInput = null;
      if (!userInput) continue;
      if (userInput === "exit" || userInput === "quit") {
        output.write("Goodbye.\n");
        break;
      }

      history.push({ role: "user", content: userInput });
      output.write("Thinking...\n");

      const plan = await brain.plan(history, userInput);

      if (plan.action === "exit") {
        output.write(`${plan.reply}\n`);
        break;
      }

      if (plan.action === "clarify" || !plan.search) {
        const response = [plan.reply, plan.followUp].filter(Boolean).join("\n");
        output.write(`${response}\n`);
        history.push({ role: "assistant", content: response });
        continue;
      }

      const inferred = inferFilters(userInput, plan.search);
      const effectiveSearch = inferred.search;
      const { intent } = inferred;

      // Ask clarifying questions — LLM generates questions specific to this query
      const questions = await brain.generateClarifyingQuestions(userInput, sessionPrefs);
      if (questions.length > 0) {
        output.write(chalk.cyan.bold("\nA few questions to sharpen the search:\n\n"));
        for (let qi = 0; qi < questions.length; qi++) {
          const { key, text } = questions[qi];
          const answer = (await rl.question(`${chalk.dim(`${qi + 1}.`)} ${text}\n> `)).trim().toLowerCase();

          const isDismissed = !answer || /^(any|skip|no|nope|doesn.?t matter|don.?t care|idc|n\/a)$/.test(answer);
          if (isDismissed) {
            sessionPrefs.skipped.add(key);
            continue;
          }

          // Freshness
          if (!effectiveSearch.since) {
            if (/6.?month/.test(answer)) {
              effectiveSearch.since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            } else if (/1.?year|12.?month/.test(answer)) {
              effectiveSearch.since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            }
          }

          // Stars floor from maturity answer
          if (/production|widely|established|mature|popular/.test(answer)) {
            sessionPrefs.minStars = Math.max(sessionPrefs.minStars, 1_000);
            effectiveSearch.minStars = Math.max(effectiveSearch.minStars, sessionPrefs.minStars);
          } else if (/1000|1k|thousand/.test(answer)) {
            sessionPrefs.minStars = Math.max(sessionPrefs.minStars, 1_000);
            effectiveSearch.minStars = Math.max(effectiveSearch.minStars, sessionPrefs.minStars);
          } else if (/5000|5k/.test(answer)) {
            sessionPrefs.minStars = Math.max(sessionPrefs.minStars, 5_000);
            effectiveSearch.minStars = Math.max(effectiveSearch.minStars, sessionPrefs.minStars);
          }

          // Answers set structured filters only — never appended to the query string
        }
        output.write("\n");
      }

      // Apply accumulated stars floor from session
      if (effectiveSearch.minStars < sessionPrefs.minStars) {
        effectiveSearch.minStars = sessionPrefs.minStars;
      }

      if (shouldClarifyBeforeSearch(intent)) {
        const filterText = renderAppliedFilters(inferred.applied);
        if (filterText) {
          output.write(`${filterText}\n`);
        }
        const response = buildClarificationPrompt(intent);
        output.write(`${response}\n`);
        history.push({ role: "assistant", content: response });
        continue;
      }

      output.write("Searching GitHub...\n");

      // ── Single ranking path: the staged pipeline (same engine as `npm run cli`).
      // Casts wide, gates aggressively, and returns an honest empty list rather
      // than padding with weak matches. Replaces the old hand-rolled scorer.
      let staged: StagedSearchResult;
      try {
        staged = await runStagedSearch(githubAdapter, analyzeRepo, prismaAdapter, userInput, effectiveSearch, {
          top: plan.search.top,
          random: plan.search.random,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.write(chalk.red(`  Search failed: ${msg}\n`));
        history.push({ role: "assistant", content: `Search failed: ${msg}` });
        continue;
      }

      // Drop anything already rejected this session.
      const kept = staged.results.filter((r) => !rejectedRepos.has(r.repo.fullName));

      // Pipeline transparency — the honest funnel the old scorer never showed.
      const sc = staged.stageCounts;
      output.write(
        chalk.dim(
          `  Pipeline  ${sc.stage1Raw} → ${sc.stage2QualityFloor} → ${sc.stage3PromptFit} → ${sc.stage4Ranked} → ${kept.length}` +
            `  (raw → quality → fit → ranked → shown)\n`
        )
      );

      const filterText = renderAppliedFilters(inferred.applied);
      if (filterText) {
        output.write(`${filterText}\n`);
      }

      // Honest empty state — say so instead of returning junk.
      if (kept.length === 0) {
        const emptyMsg =
          intent.confidence < 0.4
            ? "I do not have a confident read on that request yet. Try naming the repo category, stack, or deployment style."
            : "Nothing cleared the quality and prompt-fit gates for that query. Try a broader angle, or loosen how specific the ask is.";
        output.write(`${emptyMsg}\n`);
        history.push({ role: "assistant", content: emptyMsg });
        continue;
      }

      const shortlist = stagedToShortlist({ ...staged, results: kept }).slice(0, plan.search.top);
      const analyzed = shortlist.map((entry) => entry.item);
      const topConfidence = kept[0]?.confidence ?? "Low";

      let response = await brain.respond(history, userInput, effectiveSearch, analyzed);
      if (topConfidence === "Low") {
        response +=
          "\n(Low confidence — these cleared the gates, but the candidate pool was thin. Worth a sanity check.)";
      }
      output.write(`${response}\n`);
      history.push({ role: "assistant", content: response });
      const shortlistEntries = buildSeenEntries(
        userInput,
        shortlist.map((ranked) => ranked.item.search.fullName)
      );
      seenRepos.push(...shortlistEntries);
      shortlistHistory.push({ prompt: userInput, repos: shortlistEntries });
      await sessionStore.save({ seenRepos, shortlistHistory });
      await writeScoutReport(shortlist, response);
      output.write(`${renderShortlist(shortlist)}\n`);

      shortlist: while (true) {
        const selection = await promptForSelection(rl, shortlist.length);

        if (selection.kind === "exit") {
          return;
        }

        if (selection.kind === "back") {
          break;
        }

        if (selection.kind === "seen") {
          output.write(`${renderSeenRepos(seenRepos)}\n`);
          continue;
        }

        if (selection.kind === "history") {
          output.write(`${renderShortlistHistory(shortlistHistory)}\n`);
          continue;
        }

        if (selection.kind === "none") {
          shortlist.forEach((ranked) => rejectedRepos.add(ranked.item.search.fullName));
          history.push({
            role: "assistant",
            content: `Previous Shortlist (set aside for now): ${buildShortlistNames(shortlist)}`,
          });

          while (true) {
            const refinement = await promptForRefinement(rl);
            if (refinement.kind === "exit") {
              return;
            }
            if (refinement.kind === "back") {
              continue shortlist;
            }

            pendingInput = refinement.value;
            continue outer;
          }
        }

        if (selection.kind === "new") {
          output.write(chalk.cyan.bold("\nStarting fresh — what are you looking for?\n\n"));
          history.length = 0;
          rejectedRepos.clear();
          sessionPrefs.skipped.clear();
          sessionPrefs.minStars = 50;
          pendingInput = null;
          continue outer;
        }

        if (selection.kind === "rerun") {
          shortlist.forEach((ranked) => rejectedRepos.add(ranked.item.search.fullName));
          history.push({
            role: "assistant",
            content: `Previous Shortlist (set aside for now): ${buildShortlistNames(shortlist)}`,
          });

          // Collect feedback before re-running
          output.write(chalk.cyan.bold("\nWhat was missing in those results?\n"));
          output.write(chalk.dim("(e.g. more stars, more recent, different framework, broader angle — or just press Enter to retry as-is)\n\n"));
          const feedback = (await rl.question("> ")).trim().toLowerCase();

          let refinedPrompt = userInput;

          if (feedback) {
            // Stars adjustment
            if (/more stars?|higher stars?|popular|well.?known|widely.?used/.test(feedback)) {
              sessionPrefs.minStars = Math.max(sessionPrefs.minStars, 500);
              output.write(chalk.dim(`  → Raising stars floor to ${sessionPrefs.minStars}+\n`));
            }
            if (/1000|1k|thousand/.test(feedback)) {
              sessionPrefs.minStars = Math.max(sessionPrefs.minStars, 1000);
              output.write(chalk.dim(`  → Raising stars floor to ${sessionPrefs.minStars}+\n`));
            }

            // Freshness
            if (/more recent|recently updated|active|maintained/.test(feedback)) {
              output.write(chalk.dim("  → Filtering to repos updated in the last 6 months\n"));
            }

            // Append feedback terms to refine the prompt
            const feedbackTerms = normalizeSearchQuery(feedback);
            if (feedbackTerms) {
              refinedPrompt = `${userInput} ${feedbackTerms}`.trim();
            }
          }

          pendingInput = refinedPrompt;
          continue outer;
        }

        const chosen = shortlist[selection.index].item.search;
        const repoUrl = `https://github.com/${chosen.fullName}`;
        output.write(`\n${chalk.cyan.bold(chosen.fullName)}\n${chalk.blue.underline(repoUrl)}\n\n`);
        output.write(`${chalk.dim("a")} ${chalk.bold("analyze")}  — deep analysis + report\n`);
        output.write(`${chalk.dim("c")} ${chalk.bold("clone")}    — git clone into current directory\n`);
        output.write(`${chalk.dim("b")} ${chalk.bold("back")}     — return to shortlist\n\n`);
        const postChoice = (await rl.question("> ")).trim().toLowerCase();

        if (postChoice === "c" || postChoice === "clone") {
          output.write(chalk.dim(`\nCloning ${chosen.fullName}...\n`));
          try {
            execSync(`git clone https://github.com/${chosen.fullName}.git`, { stdio: "inherit" });
            output.write(chalk.green(`\nCloned into ./${chosen.fullName.split("/")[1]}\n\n`));
          } catch {
            output.write(chalk.red("Clone failed. Make sure git is installed and you have network access.\n\n"));
          }
          continue shortlist;
        }

        if (postChoice === "b" || postChoice === "back") {
          continue shortlist;
        }

        output.write(`Running in-depth analysis for ${chosen.fullName}...\n`);
        const repoContext = await buildRepoContext(githubAdapter, analyzeRepo, chosen);
        await writeAnalysisReport(repoContext);
        output.write("Report saved to ./reports/REPO_ANALYSIS.md\n");

        while (true) {
          const nextStep = await promptAfterAnalysis(rl);
          if (nextStep.kind === "exit") {
            return;
          }
          if (nextStep.kind === "back") {
            continue shortlist;
          }

          pendingInput = nextStep.value;
          continue outer;
        }
      }
    }
  } finally {
    rl.close();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
