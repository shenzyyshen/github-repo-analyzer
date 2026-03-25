import { Octokit } from "@octokit/rest";
import type { RepoApiPort, RepoRootEntry } from "../../ports/RepoApiPort.js";
import type { Repo } from "../../domain/entities/Repo.js";
import type { SearchResult } from "../../domain/entities/SearchResult.js";

export class RateLimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class GithubAdapter implements RepoApiPort {
  private readonly client: Octokit;

  constructor(token?: string) {
    this.client = new Octokit({
      auth: token,
    });
  }

  async getRepo(owner: string, repo: string): Promise<Repo> {
    const { data } = await this.withRetry(() => this.client.repos.get({ owner, repo }));
    return {
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      description: data.description ?? null,
      stars: data.stargazers_count ?? 0,
      forks: data.forks_count ?? 0,
      openIssues: data.open_issues_count ?? 0,
      defaultBranch: data.default_branch,
      pushedAt: new Date(data.pushed_at ?? Date.now()),
      createdAt: new Date(data.created_at ?? Date.now()),
    };
  }

  async getLanguages(owner: string, repo: string): Promise<Record<string, number>> {
    const { data } = await this.withRetry(() =>
      this.client.repos.listLanguages({ owner, repo })
    );
    return data ?? {};
  }

  async getIssues(owner: string, repo: string): Promise<number> {
    const { data, headers } = await this.withRetry(() =>
      this.client.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} type:issue state:open`,
        per_page: 1,
      })
    );

    const total = data?.total_count;
    if (typeof total === "number") return total;

    const headerTotal = headers?.["x-total-count"];
    if (typeof headerTotal === "string") {
      const num = Number(headerTotal);
      if (!Number.isNaN(num)) return num;
    }

    return 0;
  }

  async getContributors(owner: string, repo: string): Promise<number> {
    const { data, headers } = await this.withRetry(() =>
      this.client.repos.listContributors({
        owner,
        repo,
        per_page: 1,
        anon: "true",
      })
    );

    const linkHeader = headers?.link;
    if (typeof linkHeader === "string") {
      const lastMatch = linkHeader.match(/<[^>]+[?&]page=(\d+)[^>]*>;\s*rel="last"/);
      if (lastMatch) {
        const num = Number(lastMatch[1]);
        if (!Number.isNaN(num)) return num;
      }
    }

    return Array.isArray(data) ? data.length : 0;
  }

  async getReadme(owner: string, repo: string): Promise<string | null> {
    try {
      const { data } = await this.withRetry(() =>
        this.client.repos.getReadme({ owner, repo, mediaType: { format: "raw" } })
      );

      return typeof data === "string" ? data : null;
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error?.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async getRootContents(owner: string, repo: string): Promise<RepoRootEntry[]> {
    try {
      const { data } = await this.withRetry(() =>
        this.client.repos.getContent({ owner, repo, path: "" })
      );

      if (!Array.isArray(data)) {
        return [];
      }

      return data
        .filter((entry) => entry.type === "file" || entry.type === "dir")
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type === "dir" ? "dir" : "file",
        }));
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error?.status === 404) {
        return [];
      }
      throw err;
    }
  }

  async searchRepos(
    query: string,
    sort: "stars" | "updated" | "forks",
    perPage: number
  ): Promise<SearchResult[]> {
    const { data } = await this.withRetry(() =>
      this.client.search.repos({
        q: query,
        sort,
        order: "desc",
        per_page: perPage,
      })
    );

    return data.items.map((item) => ({
      owner: item.owner?.login ?? item.full_name.split("/")[0] ?? "",
      name: item.name,
      fullName: item.full_name,
      description: item.description ?? null,
      stars: item.stargazers_count ?? 0,
      forks: item.forks_count ?? 0,
      language: item.language ?? null,
      createdAt: new Date(item.created_at ?? Date.now()),
      pushedAt: new Date(item.pushed_at ?? Date.now()),
      topics: item.topics ?? [],
    }));
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: unknown) {
        attempt += 1;
        const error = err as {
          status?: number;
          response?: { headers?: Record<string, string | string[] | undefined> };
        };

        const status = error?.status;
        const headers = error?.response?.headers ?? {};
        const remaining = Array.isArray(headers["x-ratelimit-remaining"])
          ? headers["x-ratelimit-remaining"][0]
          : headers["x-ratelimit-remaining"];
        const resetRaw = Array.isArray(headers["x-ratelimit-reset"])
          ? headers["x-ratelimit-reset"][0]
          : headers["x-ratelimit-reset"];

        const rateLimitHit = status === 403 && remaining === "0";
        const tooManyRequests = status === 429;

        if (rateLimitHit && resetRaw) {
          const resetSeconds = Number(resetRaw);
          const nowSeconds = Math.floor(Date.now() / 1000);
          const waitSeconds = Math.max(resetSeconds - nowSeconds + 1, 1);
          if (attempt > retries) {
            throw new RateLimitError(
              `GitHub rate limit hit — try again in ${waitSeconds}s`,
              waitSeconds
            );
          }
          await this.sleep(waitSeconds * 1000);
          continue;
        }

        if (tooManyRequests || status === 403) {
          if (attempt > retries) {
            throw new RateLimitError("GitHub rate limit hit — try again later");
          }
          const delayMs = Math.pow(2, attempt - 1) * 1000;
          await this.sleep(delayMs);
          continue;
        }

        throw err;
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
