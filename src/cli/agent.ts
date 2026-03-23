#!/usr/bin/env node
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { GithubAdapter } from "../adapters/github/GithubAdapter.js";
import { PrismaAdapter } from "../adapters/database/PrismaAdapter.js";
import { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import type { Metrics } from "../domain/entities/Metrics.js";
import type { SearchResult } from "../domain/entities/SearchResult.js";

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
};

type SelectionChoice =
  | { kind: "pick"; index: number }
  | { kind: "open"; index: number }
  | { kind: "none" }
  | { kind: "back" }
  | { kind: "exit" };

type TextChoice =
  | { kind: "text"; value: string }
  | { kind: "open" }
  | { kind: "back" }
  | { kind: "exit" };

const INVALID_SELECTION_MESSAGE =
  "Enter a number between 1-5, `open <number>`, or type 'none' / 'quit'.";
const STOP_WORDS = new Set([
  "find",
  "top",
  "best",
  "repos",
  "repo",
  "repositories",
  "projects",
  "project",
  "for",
  "building",
  "build",
  "with",
  "using",
  "that",
  "a",
  "an",
  "the",
  "in",
  "to",
  "i",
  "want",
  "need",
  "looking",
  "look",
  "something",
  "tool",
  "app",
  "apps",
  "my",
  "me",
  "on",
  "of",
  "and",
  "or",
  "run",
  "running",
  "good",
  "great",
  "cool",
  "well",
]);

type IntentNormalization = {
  cleanedQuery: string;
  purposeTerms: string[];
  boostTerms: string[];
  displayPurpose: string[];
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function buildGitHubQuery(search: NonNullable<SearchPlan["search"]>): string {
  const parts: string[] = [search.query];
  if (search.language) parts.push(`language:${search.language}`);
  if (search.minStars > 0) parts.push(`stars:>${search.minStars}`);
  if (search.since) parts.push(`pushed:>${search.since}`);
  if (search.license) parts.push(`license:${search.license}`);
  return parts.join(" ");
}

function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function detectLanguage(input: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/\bpython\b/, "Python"],
    [/\btypescript\b|\btype script\b|\bts only\b/, "TypeScript"],
    [/\bjavascript\b|\bjs\b/, "JavaScript"],
    [/\brust\b/, "Rust"],
    [/\bgo\b|\bgolang\b/, "Go"],
    [/\bjava\b/, "Java"],
    [/\bc#\b|\bcsharp\b/, "C#"],
    [/\bphp\b/, "PHP"],
    [/\bruby\b/, "Ruby"],
    [/\bshell\b|\bbash\b/, "Shell"],
  ];

  for (const [pattern, language] of patterns) {
    if (pattern.test(input)) return language;
  }
  return null;
}

function inferFilters(
  userInput: string,
  search: NonNullable<SearchPlan["search"]>
): {
  search: NonNullable<SearchPlan["search"]>;
  applied: string[];
} {
  const input = userInput.toLowerCase();
  const applied: string[] = [];
  const next = { ...search };
  const intent = normalizeIntent(userInput);

  const detectedLanguage = detectLanguage(input);
  if (!next.language && detectedLanguage) {
    next.language = detectedLanguage;
    applied.push(`Language: ${detectedLanguage}`);
  } else if (next.language) {
    applied.push(`Language: ${next.language}`);
  }

  if (
    !next.since &&
    /\b(actively maintained|active maintenance|updated recently|recently updated|actively developed)\b/.test(
      input
    )
  ) {
    next.since = isoDateDaysAgo(90);
    next.sort = "updated";
    applied.push("Activity: updated in the last 90 days");
  } else if (next.since) {
    applied.push(`Activity: pushed after ${next.since}`);
  }

  if (/\blightweight\b/.test(input)) {
    next.query = `${next.query} lightweight`.trim();
    applied.push("Size/Maturity: lightweight");
  }
  if (/\bproduction[- ]ready\b/.test(input)) {
    next.query = `${next.query} production-ready`.trim();
    if (next.minStars < 1000) next.minStars = 1000;
    applied.push("Size/Maturity: production-ready");
  }
  if (/\bwell documented\b|\bwell-documented\b|\bgood docs\b/.test(input)) {
    next.query = `${next.query} documentation docs`.trim();
    applied.push("Size/Maturity: well documented");
  }

  if (/\bmit only\b|\bmit licensed\b|\bmit license\b/.test(input)) {
    next.license = "mit";
    applied.push("License: MIT");
  } else if (/\bapache\b/.test(input)) {
    next.license = "apache-2.0";
    applied.push("License: Apache-2.0");
  } else if (/\bopen source\b/.test(input)) {
    applied.push("License: open source");
  }

  if (intent.boostTerms.length > 0) {
    next.query = `${next.query} ${intent.boostTerms.join(" ")}`.trim();
  } else if (intent.cleanedQuery) {
    next.query = intent.cleanedQuery;
  }

  if (intent.displayPurpose.length > 0) {
    applied.push(`Purpose: ${intent.displayPurpose.join(", ")}`);
  }

  return { search: next, applied };
}

function renderAppliedFilters(applied: string[]): string {
  if (applied.length === 0) return "";
  return ["Applied filters:", ...applied.map((item) => `- ${item}`), ""].join("\n");
}

function normalizeSearchQuery(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !STOP_WORDS.has(word));

  return cleaned.join(" ").trim();
}

function normalizeIntent(input: string): IntentNormalization {
  let cleaned = input.toLowerCase();
  const replacements: Array<[RegExp, string]> = [
    [/\bi want\b/g, " "],
    [/\bi need\b/g, " "],
    [/\bi(?:'d| would) like\b/g, " "],
    [/\bi(?:'m| am) looking for\b/g, " "],
    [/\bon my laptop\b/g, " local desktop "],
    [/\bon desktop\b/g, " desktop "],
    [/\bopen source\b/g, " open-source "],
    [/\bwell documented\b|\bwell-documented\b|\bgood docs\b/g, " documented "],
    [/\bself hosted\b|\bself-hosted\b/g, " self-hosted "],
    [/\blocal llms?\b/g, " local-llm ollama inference chat "],
    [/\bllms?\b/g, " llm inference chat "],
    [/\brest apis?\b/g, " rest-api api-framework "],
    [/\bhttp client\b/g, " http-client api-client "],
    [/\breal time\b|\brealtime\b/g, " realtime websocket "],
    [/\bdesktop app\b|\bdesktop application\b/g, " desktop-app electron gui "],
  ];

  for (const [pattern, replacement] of replacements) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  const displayPurpose = new Set<string>();
  if (/\bdesktop-app\b|\bdesktop\b/.test(cleaned)) {
    displayPurpose.add("desktop app");
  }
  if (/\blocal-llm\b|\bllm\b|\bollama\b|\binference\b|\bchat\b/.test(cleaned)) {
    displayPurpose.add("local LLM chat / inference");
  }
  if (/\bself-hosted\b/.test(cleaned)) {
    displayPurpose.add("self-hosted");
  }
  if (/\brest-api\b|\bapi-framework\b/.test(cleaned)) {
    displayPurpose.add("REST API");
  }
  if (/\bhttp-client\b|\bapi-client\b/.test(cleaned)) {
    displayPurpose.add("HTTP client");
  }
  if (/\brealtime\b|\bwebsocket\b/.test(cleaned)) {
    displayPurpose.add("real-time / websocket");
  }

  const purposeTerms = cleaned
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .filter(
      (word) =>
        ![
          "python",
          "typescript",
          "javascript",
          "rust",
          "go",
          "java",
          "lightweight",
          "production",
          "ready",
          "documented",
          "documentation",
          "docs",
          "mit",
          "apache",
          "open",
          "source",
          "open-source",
          "actively",
          "maintained",
          "updated",
          "recently",
          "documented",
        ].includes(word)
    );

  const uniquePurposeTerms = [...new Set(purposeTerms.filter((word) => !STOP_WORDS.has(word)))];
  const boostTerms = uniquePurposeTerms.filter((term) =>
    ["ollama", "desktop-app", "realtime", "websocket", "rest-api", "api-framework", "http-client"].includes(
      term
    )
  );

  return {
    cleanedQuery: uniquePurposeTerms.join(" ").trim(),
    purposeTerms: uniquePurposeTerms,
    boostTerms,
    displayPurpose: [...displayPurpose],
  };
}

function extractPurposeTerms(input: string): string[] {
  return normalizeIntent(input).purposeTerms;
}

function tokenizeRepoText(repo: SearchResult): Set<string> {
  const bag = [
    repo.fullName,
    repo.name,
    repo.description ?? "",
    ...(repo.topics ?? []),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  return new Set(bag);
}

function scoreSearchCandidate(
  repo: SearchResult,
  search: NonNullable<SearchPlan["search"]>,
  purposeTerms: string[]
): number {
  let score = 0;
  const repoTokens = tokenizeRepoText(repo);

  if (search.language) {
    if ((repo.language ?? "").toLowerCase() === search.language.toLowerCase()) {
      score += 2;
    } else if (repo.language) {
      score -= 4;
    }
  }

  const matchedTerms = purposeTerms.filter((term) => repoTokens.has(term));
  score += matchedTerms.length * 2.5;

  if (purposeTerms.some((term) => ["ollama", "llm", "inference", "chat"].includes(term))) {
    const llmSignals = ["ollama", "llm", "inference", "chat", "desktop", "electron", "gui"];
    const signalMatches = llmSignals.filter((term) => repoTokens.has(term)).length;
    score += signalMatches * 0.75;
  }

  const ageDays = Math.floor((Date.now() - repo.pushedAt.getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays <= 7) score += 2;
  else if (ageDays <= 30) score += 1.5;
  else if (ageDays <= 180) score += 0.5;
  else score -= 1;

  score += Math.min(4, Math.log10(Math.max(repo.stars, 1)));

  if (/\blightweight\b/.test(search.query.toLowerCase()) && repoTokens.has("lightweight")) {
    score += 1;
  }
  if (/\bproduction-ready\b/.test(search.query.toLowerCase()) && repo.stars >= 1000) {
    score += 1;
  }
  if (/\bdocumentation\b|\bdocs\b/.test(search.query.toLowerCase())) {
    if (repoTokens.has("documentation") || repoTokens.has("docs")) score += 1;
  }

  return score;
}

function curateSearchResults(
  results: SearchResult[],
  search: NonNullable<SearchPlan["search"]>,
  userInput: string
): SearchResult[] {
  const purposeTerms = normalizeIntent(userInput).purposeTerms;
  const scored = results
    .map((repo) => ({
      repo,
      score: scoreSearchCandidate(repo, search, purposeTerms),
    }))
    .filter(({ repo, score }) => {
      if (search.language && repo.language && repo.language.toLowerCase() !== search.language.toLowerCase()) {
        return false;
      }
      return score >= 2;
    })
    .sort((a, b) => b.score - a.score);

  return scored.map((entry) => entry.repo);
}

function pickResults(results: SearchResult[], top: number, random: boolean): SearchResult[] {
  if (!random) return results.slice(0, top);
  const copy = [...results];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, top);
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

function buildRecommendationReason(item: AnalyzedRepo): string {
  const parts: string[] = [];
  if (item.search.stars >= 50_000) {
    parts.push("very widely adopted");
  } else if (item.search.stars >= 10_000) {
    parts.push("strong adoption");
  }

  const ageDays = Math.floor((Date.now() - getLastCommit(item).getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays <= 7) {
    parts.push("recently active");
  } else if (ageDays <= 30) {
    parts.push("active in the last month");
  }

  if (!item.error && item.metrics && item.metrics.openIssues < 100) {
    parts.push("manageable issue load");
  }

  if (parts.length === 0) {
    parts.push("relevant match for the query");
  }

  return parts.join(", ");
}

function computeScore(
  item: AnalyzedRepo,
  search: NonNullable<SearchPlan["search"]>,
  purposeTerms: string[]
): number {
  const starsScore = Math.min(3, Math.log10(Math.max(item.search.stars, 1)));
  const ageDays = Math.floor((Date.now() - getLastCommit(item).getTime()) / (24 * 60 * 60 * 1000));
  const recencyScore = ageDays <= 7 ? 2.5 : ageDays <= 30 ? 2 : ageDays <= 180 ? 1 : 0;
  const issueScore =
    item.metrics && !item.error
      ? item.metrics.openIssues <= 25
        ? 2
        : item.metrics.openIssues <= 100
        ? 1
        : 0
      : 0;
  const matchScore = Math.min(3, Math.max(0, scoreSearchCandidate(item.search, search, purposeTerms) / 3));
  return Math.max(1, Math.min(10, Math.round(starsScore + recencyScore + issueScore + matchScore)));
}

function curateAnalyzedResults(
  results: AnalyzedRepo[],
  search: NonNullable<SearchPlan["search"]>,
  userInput: string
): AnalyzedRepo[] {
  const purposeTerms = extractPurposeTerms(userInput);
  const scored = results
    .map((item) => ({
      item,
      score: computeScore(item, search, purposeTerms),
    }))
    .filter(({ item, score }) => {
      if (search.language) {
        const primaryLanguage = getPrimaryLanguage(item).toLowerCase();
        if (primaryLanguage !== search.language.toLowerCase()) {
          return false;
        }
      }
      return score >= 4;
    })
    .sort((a, b) => b.score - a.score);

  return scored.map((entry) => entry.item);
}

function isWeakShortlist(
  results: AnalyzedRepo[],
  search: NonNullable<SearchPlan["search"]>,
  userInput: string
): boolean {
  if (results.length === 0) return true;
  const purposeTerms = extractPurposeTerms(userInput);
  const scores = results.map((item) => computeScore(item, search, purposeTerms));
  const strongCount = scores.filter((score) => score >= 6).length;
  return strongCount === 0;
}

function buildRepoUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

function openUrl(url: string): void {
  const platform = process.platform;
  if (platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

function buildShortlistNames(results: AnalyzedRepo[]): string {
  const successful = results
    .filter((item) => !item.error)
    .slice(0, 3)
    .map((item) => item.search.fullName);

  if (successful.length > 0) {
    return successful.join(", ");
  }

  return results
    .slice(0, 3)
    .map((item) => item.search.fullName)
    .join(", ");
}

async function writeScoutReport(
  results: AnalyzedRepo[],
  summary: string,
  search: NonNullable<SearchPlan["search"]>,
  userInput: string
): Promise<void> {
  await mkdir("reports", { recursive: true });

  const timestamp = new Date().toISOString();
  const header = `# Repo Scout Results\n\nGenerated: ${timestamp}\n`;
  const tableHeader = [
    "| Repo | Description | Stars | Language | Last Commit | Why Recommended | Score (1-10) | Link |",
    "| --- | --- | ---: | --- | --- | --- | ---: | --- |",
  ];
  const rows = results.map((item) => {
    const repo = item.search.fullName;
    const description = (item.search.description ?? "No description provided.").replace(/\|/g, "\\|");
    const stars = item.search.stars.toLocaleString();
    const language = getPrimaryLanguage(item);
    const lastCommit = getLastCommit(item).toISOString().slice(0, 10);
    const why = item.error ? `Analysis failed: ${item.error}` : buildRecommendationReason(item);
    const score = computeScore(item, search, extractPurposeTerms(userInput));
    const link = buildRepoUrl(repo);
    return `| ${repo} | ${description} | ${stars} | ${language} | ${lastCommit} | ${why} | ${score} | ${link} |`;
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

function renderShortlist(results: AnalyzedRepo[]): string {
  return results
    .map((item, index) => {
      const description = item.search.description ?? "No description provided.";
      const link = buildRepoUrl(item.search.fullName);
      return [`${index + 1}. ${item.search.fullName}`, `   ${description}`, `   ${link}`].join("\n");
    })
    .join("\n");
}

async function promptForSelection(
  rl: ReturnType<typeof createInterface>,
  max: number
): Promise<SelectionChoice> {
  while (true) {
    const selection = (
      await rl.question(
        "Which repo would you like to analyze in depth? Enter a number, or type 'none' to refine the search.\n> "
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

    const openMatch = selection.match(/^open\s+(\d+)$/);
    if (openMatch) {
      const index = Number(openMatch[1]);
      if (Number.isInteger(index) && index >= 1 && index <= max) {
        return { kind: "open", index: index - 1 };
      }
      output.write(`${INVALID_SELECTION_MESSAGE}\n`);
      continue;
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
      await rl.question(
        "What next? Type 'open' to view the repo on GitHub, 'back' to return to the shortlist, or enter a new search.\n> "
      )
    ).trim();

    if (nextStep === "exit" || nextStep === "quit") {
      output.write("Goodbye.\n");
      return { kind: "exit" };
    }

    if (nextStep === "open") {
      return { kind: "open" };
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

function shouldExcludeRepo(repo: SearchResult, query: string, rejected: Set<string>): boolean {
  if (!rejected.has(repo.fullName)) {
    return false;
  }

  const normalizedQuery = query.toLowerCase();
  return ![
    repo.fullName.toLowerCase(),
    repo.owner.toLowerCase(),
    repo.name.toLowerCase(),
  ].some((token) => normalizedQuery.includes(token));
}

async function buildRepoContext(
  githubAdapter: GithubAdapter,
  analyzeRepo: AnalyzeRepo,
  repo: SearchResult
): Promise<RepoContext> {
  const [metrics, repoData, languages, contributors, verifiedOpenIssues] = await Promise.all([
    analyzeRepo.execute(repo.owner, repo.name, true),
    githubAdapter.getRepo(repo.owner, repo.name),
    githubAdapter.getLanguages(repo.owner, repo.name),
    githubAdapter.getContributors(repo.owner, repo.name),
    githubAdapter.getIssues(repo.owner, repo.name),
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
  };
}

async function loadScoutSelectionContext(
  repoFullName: string
): Promise<ScoutSelectionContext | null> {
  try {
    const content = await readFile("reports/REPO_SCOUT_RESULTS.md", "utf8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.startsWith("|")) continue;
      if (line.includes("Repo | Stars | Language")) continue;
      if (line.includes("---")) continue;

      const columns = line
        .split("|")
        .slice(1, -1)
        .map((part) => part.trim());

      if (columns.length < 8) continue;
      if (columns[0] !== repoFullName) continue;

      const score = Number(columns[6]);
      return {
        whyRecommended: columns[5],
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

  const selectedSection = scoutContext
    ? [
        "## Why This Repo Was Selected",
        "",
        `Scout reasoning: ${scoutContext.whyRecommended}.`,
        scoutContext.score !== null ? `Scout score: ${scoutContext.score}/10.` : null,
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
    selectedSection,
    concernsSection,
    focusSection,
    "## Project Summary",
    "",
    `${context.repoData.fullName} is a ${context.repo.language ?? "software"} repository with ${context.metrics.stars.toLocaleString()} stars and ${context.contributors.toLocaleString()} contributors.`,
    context.repoData.description ?? "No description provided.",
    "",
    "## Repository Metadata",
    "",
    `- Repo: ${context.repoData.fullName}`,
    `- URL: ${buildRepoUrl(context.repoData.fullName)}`,
    `- Default Branch: ${context.repoData.defaultBranch}`,
    `- Created At: ${context.repoData.createdAt.toISOString()}`,
    `- Last Push: ${context.repoData.pushedAt.toISOString()}`,
    `- Forks: ${context.repoData.forks.toLocaleString()}`,
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
          minStars: 0,
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

async function analyzePickedRepos(
  analyzeRepo: AnalyzeRepo,
  picked: SearchResult[]
): Promise<AnalyzedRepo[]> {
  const rows: AnalyzedRepo[] = [];

  for (const item of picked) {
    output.write(`Analyzing ${item.fullName}...\n`);
    try {
      const metrics = await analyzeRepo.execute(item.owner, item.name, false);
      rows.push({ search: item, metrics, error: null });
    } catch (err: unknown) {
      rows.push({
        search: item,
        metrics: null,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return rows;
}

async function main() {
  const prisma = new PrismaClient();
  const githubAdapter = new GithubAdapter(requireEnv("GITHUB_TOKEN"));
  const prismaAdapter = new PrismaAdapter(prisma);
  const analyzeRepo = new AnalyzeRepo(githubAdapter, prismaAdapter);
  const brain = new AiBrain();
  const rl = createInterface({ input, output });
  const history: Turn[] = [];
  const rejectedRepos = new Set<string>();
  let pendingInput: string | null = null;

  output.write("\x1bc");
  output.write("GitHub Repo Scout — what are you looking for?\n");

  try {
    outer: while (true) {
      const userInput = pendingInput ?? (await rl.question("> ")).trim();
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
      output.write("Searching GitHub...\n");
      const query = buildGitHubQuery(effectiveSearch);
      let results = await githubAdapter.searchRepos(query, effectiveSearch.sort, 100);
      if (results.length === 0) {
        const relaxedQuery = normalizeSearchQuery(effectiveSearch.query);
        if (relaxedQuery && relaxedQuery !== effectiveSearch.query) {
          output.write(`Retrying with broader query: ${relaxedQuery}\n`);
          results = await githubAdapter.searchRepos(
            buildGitHubQuery({ ...effectiveSearch, query: relaxedQuery }),
            effectiveSearch.sort,
            100
          );
        }
      }
      results = results.filter((repo) => !shouldExcludeRepo(repo, userInput, rejectedRepos));
      const curated = curateSearchResults(results, effectiveSearch, userInput);
      const picked = pickResults(curated, effectiveSearch.top, effectiveSearch.random);

      output.write("Analyzing results...\n");
      const analyzed = curateAnalyzedResults(
        await analyzePickedRepos(analyzeRepo, picked),
        effectiveSearch,
        userInput
      );
      const weakShortlist = isWeakShortlist(analyzed, effectiveSearch, userInput);
      const response = weakShortlist
        ? "I found only weak matches for that request. Try refining by framework, maintenance level, stars, or license."
        : await brain.respond(history, userInput, effectiveSearch, analyzed);
      await writeScoutReport(analyzed, response, effectiveSearch, userInput);
      const filterText = renderAppliedFilters(inferred.applied);
      if (filterText) {
        output.write(`${filterText}\n`);
      }
      output.write(`${response}\n`);
      history.push({ role: "assistant", content: response });

      if (analyzed.length === 0 || weakShortlist) {
        continue;
      }

      output.write(`${renderShortlist(analyzed)}\n`);

      shortlist: while (true) {
        const selection = await promptForSelection(rl, analyzed.length);

        if (selection.kind === "exit") {
          return;
        }

        if (selection.kind === "open") {
          const repo = analyzed[selection.index].search;
          const url = buildRepoUrl(repo.fullName);
          output.write(`Opening ${url}\n`);
          openUrl(url);
          continue;
        }

        if (selection.kind === "back") {
          break;
        }

        if (selection.kind === "none") {
          analyzed.forEach((item) => rejectedRepos.add(item.search.fullName));
          history.push({
            role: "assistant",
            content: `Previous Search (rejected): ${buildShortlistNames(analyzed)}`,
          });

          while (true) {
            const refinement = await promptForRefinement(rl);
            if (refinement.kind === "exit") {
              return;
            }
            if (refinement.kind === "back") {
              continue shortlist;
            }
            if (refinement.kind !== "text") {
              continue;
            }

            pendingInput = refinement.value;
            continue outer;
          }
        }

        const chosen = analyzed[selection.index].search;
        output.write(`Running in-depth analysis for ${chosen.fullName}...\n`);
        const repoContext = await buildRepoContext(githubAdapter, analyzeRepo, chosen);
        await writeAnalysisReport(repoContext);
        output.write("Report saved to ./reports/REPO_ANALYSIS.md\n");

        while (true) {
          const nextStep = await promptAfterAnalysis(rl);
          if (nextStep.kind === "exit") {
            return;
          }
          if (nextStep.kind === "open") {
            const url = buildRepoUrl(chosen.fullName);
            output.write(`Opening ${url}\n`);
            openUrl(url);
            continue;
          }
          if (nextStep.kind === "back") {
            continue shortlist;
          }
          if (nextStep.kind !== "text") {
            continue;
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
