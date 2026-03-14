import Table from "cli-table3";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import type { Metrics } from "../domain/entities/Metrics.js";
import type { SearchResult } from "../domain/entities/SearchResult.js";

export type AnalyzeRow = {
  rank: number;
  search: SearchResult;
  metrics?: Metrics;
  error?: string;
};

function getPrimaryLanguage(languages: Record<string, number>): string | null {
  let best: { name: string; bytes: number } | null = null;
  for (const [name, bytes] of Object.entries(languages)) {
    if (!best || bytes > best.bytes) {
      best = { name, bytes };
    }
  }
  return best ? best.name : null;
}

function formatGrowth(value?: string): string {
  if (!value) return chalk.gray("N/A");
  if (value.includes("N/A")) return chalk.gray(value);
  if (value.startsWith("+") && value !== "+0") return chalk.green(value);
  return value;
}

function formatStars(stars: number): string {
  return stars > 10_000 ? chalk.yellow(stars.toLocaleString()) : String(stars);
}

function formatLastCommit(date: Date | null): string {
  if (!date) return "N/A";
  const sixMonthsMs = 6 * 30 * 24 * 60 * 60 * 1000;
  const age = Date.now() - date.getTime();
  const label = date.toISOString().slice(0, 10);
  return age > sixMonthsMs ? chalk.red(label) : label;
}

export function createSpinner(text: string): Ora {
  return ora(text).start();
}

export function renderTable(rows: AnalyzeRow[]): string {
  const table = new Table({
    head: ["Rank", "Repo", "Stars", "24h Growth", "Language", "Open Issues", "Last Commit"],
  });

  for (const row of rows) {
    const repoLabel = row.search.fullName;
    if (row.error) {
      table.push([
        row.rank,
        repoLabel,
        formatStars(row.search.stars),
        chalk.red("error"),
        row.search.language ?? "—",
        "—",
        formatLastCommit(row.search.pushedAt),
      ]);
      continue;
    }

    const metrics = row.metrics;
    const language = metrics ? getPrimaryLanguage(metrics.languages) : row.search.language;
    const lastCommit = metrics ? metrics.lastCommit : row.search.pushedAt;

    table.push([
      row.rank,
      repoLabel,
      formatStars(metrics?.stars ?? row.search.stars),
      formatGrowth(metrics?.starGrowth24h),
      language ?? "—",
      metrics ? metrics.openIssues : "—",
      formatLastCommit(lastCommit),
    ]);
  }

  return table.toString();
}

export function renderSummary(count: number): string {
  return `Analyzed ${count} repos · saved to DB · run \`GET /repos/:owner/:repo\` to fetch any result`;
}
