import { Octokit } from "@octokit/rest";
import type { RepoApiPort } from "../../ports/RepoApiPort.js";
import type { Repo } from "../../domain/entities/Repo.js";

export class GithubAdapter implements RepoApiPort {
  private readonly client: Octokit;

  constructor(token?: string) {
    this.client = new Octokit({
      auth: token,
    });
  }

  async getRepo(owner: string, repo: string): Promise<Repo> {
    const { data } = await this.client.repos.get({ owner, repo });
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
    const { data } = await this.client.repos.listLanguages({ owner, repo });
    return data ?? {};
  }

  async getIssues(owner: string, repo: string): Promise<number> {
    const { data, headers } = await this.client.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} type:issue state:open`,
      per_page: 1,
    });

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
    const { data, headers } = await this.client.repos.listContributors({
      owner,
      repo,
      per_page: 1,
      anon: "true",
    });

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
}
