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
  return parts.join(" ");
}

function normalizeSearchQuery(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      (word) =>
        !new Set([
          "find",
          "top",
          "best",
          "repos",
          "repo",
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
        ]).has(word)
    );

  return cleaned.join(" ").trim();
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

async function writeScoutReport(results: AnalyzedRepo[], summary: string): Promise<void> {
  await mkdir("reports", { recursive: true });

  const timestamp = new Date().toISOString();
  const header = `# Repo Scout Results\n\nGenerated: ${timestamp}\n`;
  const tableHeader = [
    "| Repo | Stars | Language | Last Commit | Why Recommended | Score (1-10) |",
    "| --- | ---: | --- | --- | --- | ---: |",
  ];
  const rows = results.map((item) => {
    const repo = item.search.fullName;
    const stars = item.search.stars.toLocaleString();
    const language = getPrimaryLanguage(item);
    const lastCommit = getLastCommit(item).toISOString().slice(0, 10);
    const why = item.error ? `Analysis failed: ${item.error}` : buildRecommendationReason(item);
    const score = computeScore(item);
    return `| ${repo} | ${stars} | ${language} | ${lastCommit} | ${why} | ${score} |`;
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
    .map((item, index) => `${index + 1}. ${item.search.fullName}`)
    .join("\n");
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

      if (columns.length < 6) continue;
      if (columns[0] !== repoFullName) continue;

      const score = Number(columns[5]);
      return {
        whyRecommended: columns[4],
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
    while (true) {
      const userInput = pendingInput ?? (await rl.question("> ")).trim();
      pendingInput = null;
      if (!userInput) continue;
      if (userInput === "exit" || userInput === "quit") break;

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

      output.write("Searching GitHub...\n");
      const query = buildGitHubQuery(plan.search);
      let results = await githubAdapter.searchRepos(query, plan.search.sort, 100);
      if (results.length === 0) {
        const relaxedQuery = normalizeSearchQuery(plan.search.query);
        if (relaxedQuery && relaxedQuery !== plan.search.query) {
          output.write(`Retrying with broader query: ${relaxedQuery}\n`);
          results = await githubAdapter.searchRepos(
            buildGitHubQuery({ ...plan.search, query: relaxedQuery }),
            plan.search.sort,
            100
          );
        }
      }
      results = results.filter((repo) => !shouldExcludeRepo(repo, userInput, rejectedRepos));
      const picked = pickResults(results, plan.search.top, plan.search.random);

      output.write("Analyzing results...\n");
      const analyzed = await analyzePickedRepos(analyzeRepo, picked);
      const response = await brain.respond(history, userInput, plan.search, analyzed);
      await writeScoutReport(analyzed, response);
      output.write(`${response}\n`);
      history.push({ role: "assistant", content: response });

      if (analyzed.length === 0) {
        continue;
      }

      output.write(`${renderShortlist(analyzed)}\n`);
      const selection = (
        await rl.question(
          "Which repo would you like to analyze in depth? Enter a number, or type 'none' to refine the search.\n> "
        )
      ).trim();

      if (selection.toLowerCase() === "none") {
        analyzed.forEach((item) => rejectedRepos.add(item.search.fullName));
        history.push({
          role: "assistant",
          content: `Previous Search (rejected): ${buildShortlistNames(analyzed)}`,
        });
        const refinement = (
          await rl.question("What would you like to change about the search?\n> ")
        ).trim();
        if (!refinement) {
          continue;
        }
        pendingInput = refinement;
        continue;
      }

      const index = Number(selection);
      if (!Number.isInteger(index) || index < 1 || index > analyzed.length) {
        output.write("Invalid selection. You can refine the search or run the agent again.\n");
        continue;
      }

      const chosen = analyzed[index - 1].search;
      output.write(`Running in-depth analysis for ${chosen.fullName}...\n`);
      const repoContext = await buildRepoContext(githubAdapter, analyzeRepo, chosen);
      await writeAnalysisReport(repoContext);
      output.write("Report saved to ./reports/REPO_ANALYSIS.md\n");
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
