/**
 * Lightweight search result returned by GitHub search.
 * This is a domain entity: plain data shape, no behavior.
 */
export interface SearchResult {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  pushedAt: Date;
  topics: string[];
}
