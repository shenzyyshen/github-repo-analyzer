import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import type { GetTrending } from "../domain/usecases/GetTrending.js";

export function createMcpServer(analyzeRepo: AnalyzeRepo, getTrending: GetTrending) {
  const server = new McpServer({
    name: "github-repo-analyzer",
    version: "0.1.0",
  });

  server.tool(
    "analyze_repo",
    {
      owner: z.string(),
      repo: z.string(),
      deep: z.boolean().optional(),
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
    {
      language: z.string().optional(),
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
