import { Command } from "commander";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { GithubAdapter } from "../adapters/github/GithubAdapter.js";
import { PrismaAdapter } from "../adapters/database/PrismaAdapter.js";
import { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import { SearchCommand } from "./SearchCommand.js";
import { QueryTranslator } from "../ai/QueryTranslator.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const program = new Command();
  program.name("github-repo-analyzer").description("Search and analyze GitHub repos");

  program
    .command("search")
    .argument("<query>", "search query")
    .option("--language <lang>", "filter by language")
    .option("--min-stars <n>", "minimum star count")
    .option("--since <date>", "pushed after date, YYYY-MM-DD")
    .option("--sort <field>", "stars | updated | forks")
    .option("--random", "pick random results from first 100")
    .option("--json", "output raw JSON and skip analyze")
    .option("--top <n>", "how many results to show/analyze (max 10)", "5")
    .action(async (query, options) => {
      const top = Math.min(Number(options.top) || 5, 10);
      const minStars =
        options.minStars !== undefined ? Number(options.minStars) || 0 : undefined;
      const sort =
        options.sort && ["stars", "updated", "forks"].includes(options.sort)
          ? options.sort
          : undefined;

      const prisma = new PrismaClient();
      const githubAdapter = new GithubAdapter(requireEnv("GITHUB_TOKEN"));
      const prismaAdapter = new PrismaAdapter(prisma);
      const analyzeRepo = new AnalyzeRepo(githubAdapter, prismaAdapter);
      const translator = new QueryTranslator(
        requireEnv("OPENAI_API_KEY"),
        process.env.OPENAI_MODEL
      );
      const command = new SearchCommand(githubAdapter, analyzeRepo, translator);

      try {
        await command.execute(query, {
          language: options.language,
          minStars,
          since: options.since,
          sort,
          random: Boolean(options.random),
          json: Boolean(options.json),
          top,
        });
      } finally {
        await prisma.$disconnect();
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
