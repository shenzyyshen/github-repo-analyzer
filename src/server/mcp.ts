import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import type { GetTrending } from "../domain/usecases/GetTrending.js";
import type { RepoApiPort } from "../ports/RepoApiPort.js";
import type { RepoIntelligencePort } from "../ports/RepoIntelligencePort.js";
import { runStagedSearch, type StagedSearchResult } from "../domain/usecases/SearchRepos.js";

/**
 * Trims the pipeline's full internal result down to what an MCP client
 * actually needs. The raw RankedRepo carries README text and scoring
 * internals that would waste the client's context window.
 */
export function toMcpSearchPayload(result: StagedSearchResult) {
  return {
    query: result.query,
    intent: {
      artifactType: result.classification.artifactType,
      domainSpeed: result.classification.domainSpeed,
      specificity: result.classification.specificity,
      mode: result.classification.intentMode,
      confidence: result.classification.confidence,
    },
    appliedFilters: result.appliedFilters,
    stageCounts: result.stageCounts,
    results: result.results.map((entry) => ({
      fullName: entry.repo.fullName,
      url: `https://github.com/${entry.repo.fullName}`,
      description: entry.repo.description,
      language: entry.repo.language,
      stars: entry.repo.stars,
      forks: entry.repo.forks,
      lastPushed: entry.repo.pushedAt.toISOString(),
      artifactType: entry.artifactType,
      ownerTier: entry.ownerTier,
      healthScore: entry.healthScore,
      decay: entry.decay,
      dependencyHealth: entry.dependencyHealth,
      confidence: entry.confidence,
      promptFit: Math.round(entry.promptFit * 100) / 100,
      freshness: Math.round(entry.freshness * 100) / 100,
      finalScore: Math.round(entry.finalScore * 1000) / 1000,
      whyThisRepo: entry.whyThisRepo,
      note: entry.note,
      alternativesNote: entry.alternativesNote,
    })),
  };
}

export function createMcpServer(
  analyzeRepo: AnalyzeRepo,
  getTrending: GetTrending,
  repoApiPort: RepoApiPort,
  repoIntelligencePort: RepoIntelligencePort
) {
  const server = new McpServer({
    name: "github-repo-analyzer",
    version: "0.1.0",
  });

  server.tool(
    "search_repos",
    "Find GitHub repositories from a natural-language description of what you need. " +
      "Runs a staged pipeline: expands the request into several GitHub queries, merges and " +
      "deduplicates candidates, drops archived/forked/undocumented/stale repos, then ranks " +
      "survivors by how well they fit the request plus repo health, freshness, owner tier, " +
      "and decay signals. Returns a ranked shortlist where each entry explains why it placed " +
      "there. Prefer this over a raw GitHub search when the user describes a need rather than " +
      "naming a specific repository.",
    {
      query: z
        .string()
        .describe("Plain-English description of the wanted repo, e.g. 'self-hosted uptime monitoring with a web dashboard'"),
      language: z.string().optional().describe("Restrict to a programming language, e.g. 'TypeScript'"),
      minStars: z.number().int().nonnegative().optional().describe("Minimum star count"),
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Only repos pushed after this date (YYYY-MM-DD)"),
      mode: z
        .enum(["best_match", "best_shortlist"])
        .optional()
        .describe("best_match returns the single strongest repo; best_shortlist returns several to compare"),
      top: z.number().int().min(1).max(10).optional().describe("How many results to return (1-10, default 5)"),
    },
    async ({ query, language, minStars, since, mode, top }) => {
      const result = await runStagedSearch(
        repoApiPort,
        analyzeRepo,
        repoIntelligencePort,
        query,
        {
          query,
          language: language ?? null,
          minStars: minStars ?? 0,
          since: since ?? null,
          license: null,
          sort: "stars",
          top: top ?? 5,
          random: false,
        },
        { requestedMode: mode, top: top ?? 5 }
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(toMcpSearchPayload(result), null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "analyze_repo",
    "Fetch current metrics for one specific GitHub repository you already know by name: " +
      "stars, 24-hour star growth, language breakdown, open issues, contributor count, and " +
      "last commit date. Use when the user names a repo; use search_repos to find one instead.",
    {
      owner: z.string().describe("Repository owner or organization, e.g. 'facebook'"),
      repo: z.string().describe("Repository name, e.g. 'react'"),
      deep: z
        .boolean()
        .optional()
        .describe("Verify the open-issue count with an extra API call (slower, more accurate)"),
    },
    async ({ owner, repo, deep }) => {
      const result = await analyzeRepo.execute(owner, repo, deep);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  server.tool(
    "get_trending",
    "List repositories with the strongest recent star growth from those already analyzed " +
      "and cached locally. Optionally filter by primary language. Note: this reflects repos " +
      "this tool has seen before, not a global GitHub trending feed.",
    {
      language: z.string().optional().describe("Filter by primary language, e.g. 'Python'"),
    },
    async ({ language }) => {
      const result = await getTrending.execute(language);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  return server;
}

export async function connectMcpServer(server: McpServer) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
