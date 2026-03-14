import type { Repo } from "../domain/entities/Repo.js";
import type { SearchResult } from "../domain/entities/SearchResult.js";

/**
 * Port (interface) for fetching repo data from an external API (e.g. GitHub).
 * Implemented by adapters; used by use cases. No implementation here.
 */
export interface RepoApiPort {
  getRepo(owner: string, repo: string): Promise<Repo>;
  getLanguages(owner: string, repo: string): Promise<Record<string, number>>;
  getIssues(owner: string, repo: string): Promise<number>;
  getContributors(owner: string, repo: string): Promise<number>;
  searchRepos(query: string, sort: string, perPage: number): Promise<SearchResult[]>;
}
