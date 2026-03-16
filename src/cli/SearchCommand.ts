import type { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import type { RepoApiPort } from "../ports/RepoApiPort.js";
import type { SearchResult } from "../domain/entities/SearchResult.js";
import { createSpinner, renderSummary, renderTable, type AnalyzeRow } from "./display.js";
import { RateLimitError } from "../adapters/github/GithubAdapter.js";
import type { QueryTranslator } from "../ai/QueryTranslator.js";

type SearchOptions = {
  language?: string;
  minStars?: number;
  since?: string;
  sort?: "stars" | "updated" | "forks";
  random: boolean;
  json: boolean;
  top: number;
};

export class SearchCommand {
  constructor(
    private readonly repoApiPort: RepoApiPort,
    private readonly analyzeRepo: AnalyzeRepo,
    private readonly translator: QueryTranslator
  ) {}

  async execute(query: string, options: SearchOptions): Promise<void> {
    const translation = await this.translator.translate(query);
    const since = options.since ?? translation.since ?? this.getDefaultSince();
    const language = options.language ?? translation.language ?? undefined;
    const minStars =
      options.minStars !== undefined && options.minStars !== null
        ? options.minStars
        : translation.minStars ?? 0;
    const sort = options.sort ?? translation.sort ?? "stars";
    const q = this.buildQuery(translation.query, language, minStars, since);

    const results = await this.repoApiPort.searchRepos(q, sort, 100);

    if (options.json) {
      process.stdout.write(JSON.stringify(results, null, 2));
      return;
    }

    const picked = options.random
      ? this.pickRandom(results, options.top)
      : results.slice(0, options.top);

    const rows: AnalyzeRow[] = [];
    for (let i = 0; i < picked.length; i += 1) {
      const item = picked[i];
      const spinner = createSpinner(`Analyzing ${item.fullName}…`);
      try {
        const metrics = await this.analyzeRepo.execute(item.owner, item.name, false);
        rows.push({ rank: i + 1, search: item, metrics });
        spinner.succeed(`Analyzed ${item.fullName}`);
      } catch (err: unknown) {
        const message =
          err instanceof RateLimitError
            ? err.message
            : err instanceof Error
            ? err.message
            : "Unknown error";
        rows.push({ rank: i + 1, search: item, error: message });
        spinner.fail(`Failed ${item.fullName}: ${message}`);
      }
    }

    process.stdout.write(renderTable(rows));
    process.stdout.write("\n");
    process.stdout.write(renderSummary(rows.length));
    process.stdout.write("\n");
  }

  private buildQuery(
    query: string,
    language: string | undefined,
    minStars: number,
    since: string
  ): string {
    const parts: string[] = [query];
    if (language) parts.push(`language:${language}`);
    if (minStars > 0) parts.push(`stars:>${minStars}`);
    if (since) parts.push(`pushed:>${since}`);
    return parts.join(" ");
  }

  private pickRandom(results: SearchResult[], top: number): SearchResult[] {
    const copy = [...results];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, top);
  }

  private getDefaultSince(): string {
    const date = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }
}
