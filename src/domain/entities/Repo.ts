/**
 * Represents a GitHub repository as returned by the GitHub API.
 * This is a domain entity: plain data shape, no behavior.
 */
export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  stars: number;
  forks: number;
  archived: boolean;
  isFork: boolean;
  openIssues: number;
  defaultBranch: string;
  pushedAt: Date;
  createdAt: Date;
}
