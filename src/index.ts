import { PrismaClient } from "@prisma/client";
import { GithubAdapter } from "./adapters/github/GithubAdapter.js";
import { PrismaAdapter } from "./adapters/database/PrismaAdapter.js";
import { AnalyzeRepo } from "./domain/usecases/AnalyzeRepo.js";
import { GetTrending } from "./domain/usecases/GetTrending.js";
import { createExpressApp } from "./server/express.js";
import { createMcpServer, connectMcpServer } from "./server/mcp.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const startMcp = args.has("--mcp");
  const startHttp = args.has("--http") || !startMcp;

  const prisma = new PrismaClient();
  const githubAdapter = new GithubAdapter(requireEnv("GITHUB_TOKEN"));
  const prismaAdapter = new PrismaAdapter(prisma);

  const analyzeRepo = new AnalyzeRepo(githubAdapter, prismaAdapter);
  const getTrending = new GetTrending(prismaAdapter);

  if (startHttp) {
    const port = Number(process.env.PORT ?? "3005");
    const app = createExpressApp(analyzeRepo, getTrending, prismaAdapter);
    app.listen(port, () => {
      console.log(`HTTP server listening on port ${port}`);
    });
  }

  if (startMcp) {
    const mcpServer = createMcpServer(analyzeRepo, getTrending);
    await connectMcpServer(mcpServer);
    console.log("MCP server connected over stdio");
  }

  const shutdown = async () => {
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
