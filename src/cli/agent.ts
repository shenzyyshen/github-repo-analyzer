#!/usr/bin/env node
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { GithubAdapter } from "../adapters/github/GithubAdapter.js";
import { PrismaAdapter } from "../adapters/database/PrismaAdapter.js";
import { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import type { Metrics } from "../domain/entities/Metrics.js";
import type { SearchResult } from "../domain/entities/SearchResult.js";
import type { RepoReleaseInfo, RepoRootEntry } from "../ports/RepoApiPort.js";
import {
  buildRetrievalQueries,
  buildBroaderSearchQuery,
  buildClarificationPrompt,
  inferFilters,
  normalizeSearchQuery,
  type ParsedIntent,
  renderAppliedFilters,
  shouldClarifyBeforeSearch,
} from "./intent.js";

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
  | { kind: "back" }
  | { kind: "exit" };

type TextChoice =
  | { kind: "text"; value: string }
  | { kind: "back" }
  | { kind: "exit" };

const INVALID_SELECTION_MESSAGE = "Enter a number between 1-5, or type 'none' / 'quit'.";

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

function computeScore(item: AnalyzedRepo): number {
  const starsScore = Math.min(5, Math.log10(Math.max(item.search.stars, 1)));
  const ageDays = Math.floor((Date.now() - getLastCommit(item).getTime()) / (24 * 60 * 60 * 1000));
  const recencyScore = ageDays <= 7 ? 3 : ageDays <= 30 ? 2 : ageDays <= 180 ? 1 : 0;
  const issueScore =
    item.metrics && !item.error
      ? item.metrics.openIssues <= 50
        ? 2
        : item.metrics.openIssues <= 200
        ? 1
        : 0
      : 0;
  return Math.max(1, Math.min(10, Math.round(starsScore + recencyScore + issueScore)));
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

function tokenizeRepo(item: AnalyzedRepo): Set<string> {
  return new Set(
    [
      item.search.fullName,
      item.search.name,
      item.search.description ?? "",
      getPrimaryLanguage(item),
      item.readme ?? "",
      ...item.rootContents.map((entry) => entry.name),
      ...(item.search.topics ?? []),
    ]
      .join(" ")
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

function tokenizeSearchResult(repo: SearchResult): Set<string> {
  return new Set(
    [
      repo.fullName,
      repo.name,
      repo.description ?? "",
      repo.language ?? "",
      ...(repo.topics ?? []),
    ]
      .join(" ")
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

function preselectCandidates(
  results: SearchResult[],
  intent: ParsedIntent,
  top: number,
  random: boolean
): SearchResult[] {
  if (random) {
    return pickResults(results, top, true);
  }

  const candidatePoolSize = Math.min(Math.max(top * 4, 15), 25, results.length);
  const scored = results
    .map((repo) => {
      const tokens = tokenizeSearchResult(repo);
      const intentTerms = [
        ...intent.purposeTerms,
        ...intent.boostTerms,
        ...intent.concepts,
        ...intent.displayTerms.flatMap((term) => term.toLowerCase().split(/\s+/)),
      ].filter(Boolean);
      const termMatches = [...new Set(intentTerms)].filter((term) => tokens.has(term)).length;
      const languageBonus =
        intent.language && repo.language && repo.language.toLowerCase() === intent.language.toLowerCase() ? 2 : 0;
      const starsBonus =
        repo.stars >= 10_000
          ? 4
          : repo.stars >= 1_000
            ? 3
            : repo.stars >= 100
              ? 2
              : repo.stars >= 25
                ? 1
                : 0;
      const forksBonus =
        repo.forks >= 1_000
          ? 3
          : repo.forks >= 100
            ? 2
            : repo.forks >= 10
              ? 1
              : 0;
      const repoAgeDays = Math.max(1, Math.floor((Date.now() - repo.createdAt.getTime()) / (24 * 60 * 60 * 1000)));
      const maturityBonus =
        repoAgeDays >= 365 * 2
          ? 3
          : repoAgeDays >= 365
            ? 2
            : repoAgeDays >= 90
              ? 1
              : 0;
      const pushAgeDays = Math.max(1, Math.floor((Date.now() - repo.pushedAt.getTime()) / (24 * 60 * 60 * 1000)));
      const maintenanceBonus =
        pushAgeDays <= 30
          ? 2
          : pushAgeDays <= 120
            ? 1
            : 0;
      const weakRepoPenalty =
        repo.stars < 10 && repo.forks === 0 && repoAgeDays < 30
          ? 4
          : repo.stars < 25 && repoAgeDays < 45
            ? 2
            : 0;

      const prefilterScore =
        termMatches * 3 +
        languageBonus +
        starsBonus +
        forksBonus +
        maturityBonus +
        maintenanceBonus -
        weakRepoPenalty;

      return { repo, prefilterScore };
    })
    .sort((a, b) => b.prefilterScore - a.prefilterScore);

  return scored.slice(0, candidatePoolSize).map((entry) => entry.repo);
}

async function searchMergedCandidates(
  githubAdapter: GithubAdapter,
  search: NonNullable<SearchPlan["search"]>,
  intent: ParsedIntent
): Promise<SearchResult[]> {
  const queries = buildRetrievalQueries(intent, search.query);
  const merged = new Map<string, SearchResult>();

  for (const query of queries) {
    const effectiveQuery = buildGitHubQuery({ ...search, query });
    const batch = await githubAdapter.searchRepos(effectiveQuery, search.sort, 100);
    for (const repo of batch) {
      if (!merged.has(repo.fullName)) {
        merged.set(repo.fullName, repo);
      }
    }
  }

  return [...merged.values()];
}

type PromptProfile = {
  label: string;
  strictQualityFloor: boolean;
  bestFor: Record<RankedShortlistItem["fitType"], string>;
};

function buildPromptProfile(intent: ParsedIntent): PromptProfile {
  const intentText = [intent.normalizedQuery, ...intent.displayTerms, ...intent.purposeTerms, ...intent.concepts]
    .join(" ")
    .toLowerCase();

  if (/\bmcp\b/.test(intentText) && /\b(agent|coding|code|developer)\b/.test(intentText)) {
    return {
      label: "MCP-based coding assistants",
      strictQualityFloor: true,
      bestFor: {
        "direct match": "teams building MCP-based coding assistants",
        "adaptable framework": "teams wiring an orchestration layer around MCP coding workflows",
        "production choice": "teams that want a more established MCP/coding integration starting point",
        "niche option": "teams exploring a narrower MCP workflow or newer coding assistant",
        "balanced option": "teams that want a practical MCP/coding starting point without a large platform bet",
      },
    };
  }

  if (intent.concepts.includes("monitoring") && intent.concepts.includes("self-hosted")) {
    return {
      label: "self-hosted monitoring for APIs and websites",
      strictQualityFloor: true,
      bestFor: {
        "direct match": "teams running self-hosted API and website monitoring",
        "adaptable framework": "teams that can extend a broader observability tool to their monitoring workflow",
        "production choice": "teams that prefer a more proven monitoring project over the most targeted match",
        "niche option": "teams evaluating a narrower or newer self-hosted monitoring option",
        "balanced option": "teams that want a credible monitoring option without over-optimizing for one metric",
      },
    };
  }

  if (intent.concepts.includes("local-ai") && intent.concepts.includes("desktop-app")) {
    return {
      label: "desktop local LLM apps",
      strictQualityFloor: false,
      bestFor: {
        "direct match": "teams building or adopting desktop local LLM apps",
        "adaptable framework": "teams that can adapt a desktop AI foundation into a local LLM workflow",
        "production choice": "teams that prefer a more established local AI project",
        "niche option": "teams exploring a newer or more specialized local AI app",
        "balanced option": "teams that want a practical local AI app without chasing the largest framework",
      },
    };
  }

  const label = intent.displayTerms[0] ?? "the request";
  return {
    label,
    strictQualityFloor: false,
    bestFor: {
      "direct match": `teams that want the closest match to ${label}`,
      "adaptable framework": `teams that can customize a framework around ${label}`,
      "production choice": "teams that prefer a more proven and widely adopted repo",
      "niche option": `teams evaluating a narrower or newer option in ${label}`,
      "balanced option": "teams looking for a balanced compromise between fit and maturity",
    },
  };
}

function rankShortlist(results: AnalyzedRepo[], intent: ParsedIntent): RankedShortlistItem[] {
  const prompt = buildPromptProfile(intent);
  const scored = results.map((item) => {
    const tokens = tokenizeRepo(item);
    const promptFit = intent.purposeTerms.filter((term) => tokens.has(term)).length;
    const intentText = [intent.normalizedQuery, ...intent.displayTerms, ...intent.purposeTerms, ...intent.concepts]
      .join(" ")
      .toLowerCase();
    const mcpQuery = /\bmcp\b/.test(intentText) && /\b(agent|coding|code|developer)\b/.test(intentText);
    const repoText = [item.search.fullName, item.search.description ?? "", getPrimaryLanguage(item)].join(" ").toLowerCase();
    const repoDescriptor =
      /\borchestrator|workflow\b/.test(repoText)
        ? "orchestration"
        : /\bstudio|gui|electron|desktop\b/.test(repoText)
          ? "ui"
          : /\bserver\b/.test(repoText)
            ? "server"
            : /\bcli\b/.test(repoText)
              ? "cli"
              : /\bframework|sdk|platform|toolkit\b/.test(repoText)
                ? "framework"
                : "general";
    const mcpRelevance =
      mcpQuery
        ? Number(/\bmcp\b|\bmodel context protocol\b/.test(repoText)) +
          Number(/\b(agent|assistant|orchestrator|workflow)\b/.test(repoText)) +
          Number(/\b(code|coding|developer|dev)\b/.test(repoText))
        : 0;
    const stars = item.search.stars;
    const forks = item.search.forks;
    const contributors = getContributorCount(item);
    const readmeText = (item.readme ?? "").toLowerCase();
    const rootNames = new Set(item.rootContents.map((entry) => entry.name.toLowerCase()));
    const readmeFit = intent.purposeTerms.filter((term) => readmeText.includes(term)).length;
    const topicFit = (item.search.topics ?? []).filter((topic) =>
      intent.purposeTerms.some((term) => topic.toLowerCase().includes(term))
    ).length;
    const repoAgeDays = getRepoAgeDays(item);
    const repoAgeMonths = Math.max(1, repoAgeDays / 30);
    const starVelocity = stars / repoAgeMonths;
    const ageDays = Math.floor((Date.now() - getLastCommit(item).getTime()) / (24 * 60 * 60 * 1000));
    const activityScore = ageDays <= 14 ? 3 : ageDays <= 60 ? 2 : ageDays <= 180 ? 1 : 0;
    const adoptionScore =
      stars >= 20_000 || forks >= 3_000
        ? 4
        : stars >= 5_000 || forks >= 750
          ? 3
          : stars >= 1_000 || forks >= 200 || contributors >= 25
            ? 2
            : stars >= 100 || forks >= 25 || contributors >= 5
              ? 1
              : 0;
    const maturityScore =
      repoAgeDays >= 365 * 2
        ? 3
        : repoAgeDays >= 365
          ? 2
          : repoAgeDays >= 180
            ? 1
            : 0;
    const velocityScore = starVelocity >= 500 ? 2 : starVelocity >= 100 ? 1 : 0;
    const maintainabilityScore =
      item.metrics && !item.error ? (item.metrics.openIssues <= 50 ? 2 : item.metrics.openIssues <= 200 ? 1 : 0) : 0;
    const setupSignals =
      Number(rootNames.has("dockerfile")) +
      Number(rootNames.has("docker-compose.yml") || rootNames.has("docker-compose.yaml")) +
      Number(rootNames.has(".env.example")) +
      Number(rootNames.has("package.json") || rootNames.has("pyproject.toml") || rootNames.has("requirements.txt")) +
      Number([...rootNames].some((name) => name.startsWith(".github")));
    const releaseBonus =
      item.latestRelease
        ? Math.max(
            0,
            Math.floor(
              2 -
                (Date.now() - item.latestRelease.publishedAt.getTime()) /
                  (365 * 24 * 60 * 60 * 1000)
            )
          )
        : 0;
    const frameworkLike = /\b(framework|sdk|library|toolkit|platform|starter)\b/i.test(
      item.search.description ?? ""
    );

    const passesQualityFloor = prompt.strictQualityFloor
      ? ((stars >= 50 && repoAgeDays >= 45 && contributors >= 2) ||
          (promptFit + readmeFit + topicFit + mcpRelevance >= 3 && (stars >= 20 || forks >= 5) && repoAgeDays >= 30))
      : (stars >= 10 || forks >= 2 || contributors >= 2 || repoAgeDays >= 30 || promptFit + readmeFit + topicFit >= 2);

    if (!passesQualityFloor) {
      return null;
    }

    const fitScore = Math.min(
      3,
      promptFit + readmeFit + topicFit + (mcpQuery ? Math.min(2, mcpRelevance) : 0) >= 5
        ? 3
        : promptFit + readmeFit + topicFit + (mcpQuery ? Math.min(2, mcpRelevance) : 0) >= 3
          ? 2
          : promptFit >= 1 || readmeFit >= 1 || topicFit >= 1 || mcpRelevance >= 1
            ? 1
            : 0
    );
    const adoptionRubric =
      stars >= 25_000 || forks >= 2_500 || contributors >= 100
        ? 3
        : stars >= 5_000 || forks >= 500 || contributors >= 25
          ? 2
          : stars >= 250 || forks >= 25 || contributors >= 5
            ? 1
            : 0;
    const maintenanceRubric =
      ageDays <= 30
        ? 2
        : ageDays <= 120
          ? 1
          : 0;
    const maturityRubric =
      repoAgeDays >= 365 * 2
        ? 2
        : repoAgeDays >= 180
          ? 1
          : 0;
    const bonusRubric = Math.min(1, maintainabilityScore > 0 || velocityScore > 0 ? 1 : 0);
    const setupRubric = setupSignals >= 3 ? 1 : 0;

    const fitType: RankedShortlistItem["fitType"] =
      fitScore >= 2
        ? "direct match"
        : frameworkLike
          ? "adaptable framework"
          : stars >= 5_000
            ? "production choice"
            : stars < 500
              ? "niche option"
              : "balanced option";

    const descriptorBonus =
      mcpQuery
        ? repoDescriptor === "server"
          ? 0.75
          : repoDescriptor === "orchestration"
            ? 0.5
            : repoDescriptor === "framework"
              ? 0.25
              : 0
        : 0;

    const weightedScore =
      fitScore +
      adoptionRubric +
      maintenanceRubric +
      maturityRubric +
      bonusRubric +
      setupRubric +
      Math.min(1, releaseBonus) +
      descriptorBonus;

    const whyParts: string[] = [];
    if (fitScore >= 3) whyParts.push(`most direct fit for ${prompt.label}`);
    else if (fitType === "adaptable framework") whyParts.push("adaptable foundation for this workflow");
    else if (fitType === "production choice") whyParts.push("maturity and adoption are stronger than the rest of the field");
    else if (fitType === "niche option") whyParts.push("specialized option that matches part of the prompt");
    else if (descriptorBonus > 0) whyParts.push(`${repoDescriptor} shape matches the workflow`);
    if (adoptionRubric >= 2) whyParts.push("strong adoption");
    if (maturityRubric >= 1) whyParts.push("established repo age");
    if (maintenanceRubric >= 1) whyParts.push("recent maintenance");
    if (readmeFit >= 1) whyParts.push("README reinforces the use case");
    if (topicFit >= 1) whyParts.push("repo topics match the prompt");
    if (setupRubric >= 1) whyParts.push("setup signals look credible");
    if (releaseBonus >= 1) whyParts.push("release signal is present");
    if (mcpQuery && mcpRelevance >= 2) whyParts.push("clear MCP/coding relevance");

    let tradeoff: string | null = null;
    if (fitType === "adaptable framework") tradeoff = "more setup required than a purpose-built tool";
    else if (fitType === "production choice") tradeoff = "broader scope than the most targeted option";
    else if (fitType === "niche option") tradeoff = "lower adoption signal than the top picks";
    else if (repoAgeDays < 180) tradeoff = "project is still relatively new";
    else if (setupSignals === 0) tradeoff = "setup signals are limited from the root snapshot";
    else if (!item.latestRelease) tradeoff = "no clear release signal from GitHub releases";
    else if (fitScore < 2) tradeoff = "fit is broader than the exact prompt";

    let bestFor = prompt.bestFor[fitType];
    if (mcpQuery) {
      if (repoDescriptor === "server") {
        bestFor = "teams integrating a lightweight MCP server into coding workflows";
      } else if (repoDescriptor === "orchestration") {
        bestFor = "teams orchestrating multi-agent coding workflows around MCP";
      } else if (repoDescriptor === "ui") {
        bestFor = "teams exploring a UI-first coding assistant environment";
      } else if (repoDescriptor === "framework") {
        bestFor = "teams building a broader coding-agent platform with MCP support";
      }
    }

    return {
      item,
      score: Math.max(1, Math.min(10, Math.round(weightedScore))),
      why: whyParts.join("; "),
      tradeoff,
      risk: buildRiskSummary(item),
      bestFor,
      fitType,
    };
  }).filter(Boolean) as RankedShortlistItem[];

  const ranked: RankedShortlistItem[] = [];
  const seenTypes = new Set<string>();
  const pool = [...scored];

  while (pool.length > 0) {
    pool.sort((a, b) => {
      const aPenalty = seenTypes.has(a.fitType) ? 1.25 : 0;
      const bPenalty = seenTypes.has(b.fitType) ? 1.25 : 0;
      return b.score - bPenalty - (a.score - aPenalty);
    });
    const next = pool.shift();
    if (!next) break;
    ranked.push(next);
    seenTypes.add(next.fitType);
  }

  return ranked;
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
    return `analysis failed: ${item.error}`;
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

function renderShortlist(results: RankedShortlistItem[]): string {
  return results
    .map((ranked, index) => {
      const { item } = ranked;
      const caution = buildRiskSummary(item);
      const stars = item.search.stars.toLocaleString();
      const forks = item.search.forks.toLocaleString();
      const contributors = getContributorCount(item).toLocaleString();
      const age = getRepoAgeLabel(item);
      const lastCommit = getLastCommit(item).toISOString().slice(0, 10);
      const language = getPrimaryLanguage(item);
      const lines = [
        `${index + 1}. ${item.search.fullName}`,
        `   Score: ${ranked.score}/10`,
        `   Best for: ${ranked.bestFor}`,
        `   Why: ${ranked.why}`,
        ranked.tradeoff ? `   Tradeoff: ${ranked.tradeoff}` : null,
        caution ? `   Risk: ${caution}` : null,
        `   Stars: ${stars} | Forks: ${forks} | Contributors: ${contributors}`,
        `   Age: ${age} | Last push: ${lastCommit} | Language: ${language}`,
        `   GitHub: ${buildRepoUrl(item.search.fullName)}`,
      ].filter(Boolean);

      return lines.join("\n");
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
  githubAdapter: GithubAdapter,
  analyzeRepo: AnalyzeRepo,
  picked: SearchResult[]
): Promise<AnalyzedRepo[]> {
  const rows: AnalyzedRepo[] = [];

  for (const item of picked) {
    output.write(`Analyzing ${item.fullName}...\n`);
    try {
      const [metrics, readme, rootContents, latestRelease] = await Promise.all([
        analyzeRepo.execute(item.owner, item.name, false),
        githubAdapter.getReadme(item.owner, item.name),
        githubAdapter.getRootContents(item.owner, item.name),
        githubAdapter.getLatestRelease(item.owner, item.name),
      ]);
      rows.push({ search: item, metrics, error: null, readme, rootContents, latestRelease });
    } catch (err: unknown) {
      rows.push({
        search: item,
        metrics: null,
        error: err instanceof Error ? err.message : "Unknown error",
        readme: null,
        rootContents: [],
        latestRelease: null,
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
      const { intent } = inferred;

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
      const query = buildGitHubQuery(effectiveSearch);
      let results = await searchMergedCandidates(githubAdapter, effectiveSearch, intent);
      if (results.length === 0) {
        if (intent.confidence < 0.4) {
          const filterText = renderAppliedFilters(inferred.applied);
          if (filterText) {
            output.write(`${filterText}\n`);
          }
          const response =
            "I am not confident I interpreted that request correctly. Try naming the product type, language, or license you care about most.";
          output.write(`${response}\n`);
          history.push({ role: "assistant", content: response });
          continue;
        }

        const broaderQuery = buildBroaderSearchQuery(intent);
        if (broaderQuery && broaderQuery !== effectiveSearch.query) {
          output.write(`Retrying with broader query: ${broaderQuery}\n`);
          results = await searchMergedCandidates(githubAdapter, { ...effectiveSearch, query: broaderQuery }, intent);
        }

        const relaxedQuery = normalizeSearchQuery(effectiveSearch.query);
        if (results.length === 0 && relaxedQuery && relaxedQuery !== effectiveSearch.query) {
          output.write(`Retrying with broader query: ${relaxedQuery}\n`);
          results = await searchMergedCandidates(githubAdapter, { ...effectiveSearch, query: relaxedQuery }, intent);
        }

        if (results.length === 0) {
          const fallbackQuery = broaderQuery ?? relaxedQuery ?? effectiveSearch.query;
          const relaxedSearch = {
            ...effectiveSearch,
            query: fallbackQuery,
            since: null,
            license: null,
            minStars: 0,
            sort: "stars" as const,
          };
          output.write(`Retrying with relaxed filters: ${fallbackQuery}\n`);
          results = await searchMergedCandidates(githubAdapter, relaxedSearch, intent);
        }
      }
      results = results.filter((repo) => !shouldExcludeRepo(repo, userInput, rejectedRepos));
      const candidates = preselectCandidates(results, intent, plan.search.top, plan.search.random);
      const hadCandidates = candidates.length > 0;

      output.write("Analyzing results...\n");
      const analyzed = await analyzePickedRepos(githubAdapter, analyzeRepo, candidates);
      const response =
        analyzed.length === 0
          ? intent.confidence < 0.4
            ? "I still do not have a confident read on that request. Try specifying the repo category, stack, or deployment style."
            : hadCandidates
              ? "I did not find perfect matches, but I found a few plausible repos worth checking."
            : "I did not find strong matches for that query. Try narrowing by framework, language, stars, or maintenance level."
          : await brain.respond(history, userInput, effectiveSearch, analyzed);
      const filterText = renderAppliedFilters(inferred.applied);
      if (filterText) {
        output.write(`${filterText}\n`);
      }
      output.write(`${response}\n`);
      history.push({ role: "assistant", content: response });

      if (analyzed.length === 0 && !hadCandidates) {
        continue;
      }

      const shortlist = rankShortlist(
        analyzed.length > 0
          ? analyzed
          : candidates.map((search) => ({
              search,
              metrics: null,
              error: null,
              readme: null,
              rootContents: [],
              latestRelease: null,
            })),
        intent
      ).slice(0, plan.search.top);
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

        if (selection.kind === "none") {
          shortlist.forEach((ranked) => rejectedRepos.add(ranked.item.search.fullName));
          history.push({
            role: "assistant",
            content: `Previous Search (rejected): ${buildShortlistNames(shortlist)}`,
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

        const chosen = shortlist[selection.index].item.search;
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
