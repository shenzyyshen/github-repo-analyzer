import type { Repo } from "../domain/entities/Repo.js";
import type { SearchResult } from "../domain/entities/SearchResult.js";

export interface RepoRootEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

export interface RepoReleaseInfo {
  tagName: string;
  publishedAt: Date;
}

/**
 * Port (interface) for fetching repo data from an external API (e.g. GitHub).
 * Implemented by adapters; used by use cases. No implementation here.
 */
export interface RepoApiPort {
  getRepo(owner: string, repo: string): Promise<Repo>;
  getLanguages(owner: string, repo: string): Promise<Record<string, number>>;
  getIssues(owner: string, repo: string): Promise<number>;
  getContributors(owner: string, repo: string): Promise<number>;
  getReadme(owner: string, repo: string): Promise<string | null>;
  getRootContents(owner: string, repo: string): Promise<RepoRootEntry[]>;
  getLatestRelease(owner: string, repo: string): Promise<RepoReleaseInfo | null>;
  searchRepos(
    query: string,
    sort: "stars" | "updated" | "forks",
    perPage: number
  ): Promise<SearchResult[]>;
}
