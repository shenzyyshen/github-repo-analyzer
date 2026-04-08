import type { AnalyzeRepo } from "../domain/usecases/AnalyzeRepo.js";
import type { RepoApiPort } from "../ports/RepoApiPort.js";
import type { QueryTranslator } from "../ai/QueryTranslator.js";
import { renderStagedSearch, runStagedSearch, type IntentMode } from "./stagedSearch.js";

type SearchOptions = {
  language?: string;
  minStars?: number;
  since?: string;
  mode?: IntentMode;
  sort?: "stars" | "updated" | "forks";
  random: boolean;
  json: boolean;
  explain: boolean;
  top: number;
};

export class SearchCommand {
  constructor(
    private readonly repoApiPort: RepoApiPort,
    private readonly analyzeRepo: AnalyzeRepo,
    private readonly translator: QueryTranslator
  ) {}

  async execute(query: string, options: SearchOptions): Promise<void> {
    process.stdout.write("Translating query...\n");
    const translation = await this.translator.translate(query);
    const since = options.since ?? translation.since ?? this.getDefaultSince();
    const language = options.language ?? translation.language ?? undefined;
    const minStars =
      options.minStars !== undefined && options.minStars !== null
        ? options.minStars
        : translation.minStars ?? 0;
    const sort = options.sort ?? translation.sort ?? "stars";
    const q = translation.query;

    process.stdout.write("Running staged retrieval and ranking...\n");
    const result = await runStagedSearch(
      this.repoApiPort,
      this.analyzeRepo,
      query,
      {
        query: q,
        language: language ?? null,
        minStars,
        since,
        license: null,
        sort,
        top: options.top,
        random: options.random,
      },
      {
        requestedMode: options.mode,
        top: options.top,
        random: options.random,
        explain: options.explain,
      }
    );

    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2));
    } else {
      process.stdout.write(renderStagedSearch(result, options.explain));
    }
  }

  private getDefaultSince(): string {
    const date = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  }
}
