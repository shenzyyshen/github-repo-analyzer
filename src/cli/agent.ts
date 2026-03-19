import "dotenv/config";
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
      const names = results
        .filter((item) => !item.error)
        .slice(0, 3)
        .map((item) => item.search.fullName)
        .join(", ");
      return `I found a shortlist worth checking: ${names}. Do you want me to narrow further by framework, stars, or maintenance activity?`;
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

  output.write("🤖 GitHub Repo Analyzer — What are you looking for?\n");

  try {
    while (true) {
      const userInput = (await rl.question("> ")).trim();
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
      const picked = pickResults(results, plan.search.top, plan.search.random);

      output.write("Analyzing results...\n");
      const analyzed = await analyzePickedRepos(analyzeRepo, picked);
      const response = await brain.respond(history, userInput, plan.search, analyzed);
      output.write(`${response}\n`);
      history.push({ role: "assistant", content: response });
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
