#!/usr/bin/env node
import "dotenv/config";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { PrismaClient } from "@prisma/client";
import { GithubAdapter } from "../adapters/github/GithubAdapter.js";
import { PrismaAdapter } from "../adapters/database/PrismaAdapter.js";
import { FileSessionStore } from "../adapters/session/FileSessionStore.js";
import { MarkdownReportWriter } from "../adapters/reports/MarkdownReportWriter.js";
import { OpenAiAdapter } from "../adapters/llm/OpenAiAdapter.js";
import { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import { AnalyzeRepoDeep } from "../domain/usecases/AnalyzeRepoDeep.js";
import type { Metrics } from "../domain/entities/Metrics.js";
import type { SearchResult } from "../domain/entities/SearchResult.js";
import type { SeenRepoEntry, ShortlistHistoryEntry } from "../domain/entities/SessionState.js";
import type { RepoReleaseInfo, RepoRootEntry } from "../ports/RepoApiPort.js";
import type { ReportWriterPort } from "../ports/ReportWriterPort.js";
import type { LlmPort } from "../ports/LlmPort.js";
import {
  buildRetrievalQueries,
  buildClarificationPrompt,
  createSessionPreferences,
  generateClarifyingQuestions as ruleBasedClarifyingQuestions,
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

async function writeScoutReport(
  reportWriterPort: ReportWriterPort,
  results: RankedShortlistItem[],
  summary: string
): Promise<void> {
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

  await reportWriterPort.writeScoutReport(content);
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

class AiBrain {
  constructor(private readonly llmPort: LlmPort) {}

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
      const raw = await this.llmPort.generateText(prompt);
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
      return await this.llmPort.generateText(prompt);
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
    intent: ParsedIntent,
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
      const raw = await this.llmPort.generateText(prompt);
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start === -1 || end === -1) throw new Error("No JSON array found");
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Array<{ key: string; text: string }>;
      return parsed
        .filter((q) => q.key && q.text && !prefs.skipped.has(q.key))
        .slice(0, 4);
    } catch {
      // LLM unavailable or returned junk — fall back to the rule-based
      // generator instead of asking nothing. Every other LLM call site in
      // this file degrades to a non-AI fallback on failure (plan(),
      // QueryTranslator.translate()); this one silently returned [] until
      // now, which meant a flaky LLM call skipped clarification entirely
      // rather than degrading it.
      return ruleBasedClarifyingQuestions(intent, userInput, prefs);
    }
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
  const analyzeRepo = new AnalyzeRepo(githubAdapter, prismaAdapter, prismaAdapter);
  const sessionStore = new FileSessionStore();
  const reportWriter = new MarkdownReportWriter();
  const analyzeRepoDeep = new AnalyzeRepoDeep(githubAdapter, analyzeRepo, reportWriter);
  const llmPort = new OpenAiAdapter({
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    claudeApiKey: process.env.CLAUDE_API_KEY ?? null,
    claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514",
  });
  const brain = new AiBrain(llmPort);
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
      const questions = await brain.generateClarifyingQuestions(intent, userInput, sessionPrefs);
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
      await writeScoutReport(reportWriter, shortlist, response);
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
        await analyzeRepoDeep.execute(chosen);
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
