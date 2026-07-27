/**
 * A repo surfaced in a shortlist during this or a prior session.
 */
export interface SeenRepoEntry {
  prompt: string;
  fullName: string;
  url: string;
}

/**
 * One past shortlist run, keyed by the prompt that produced it.
 */
export interface ShortlistHistoryEntry {
  prompt: string;
  repos: SeenRepoEntry[];
}

/**
 * Cross-run session memory: everything the CLI recalls via `seen` / `history`.
 */
export interface SessionState {
  seenRepos: SeenRepoEntry[];
  shortlistHistory: ShortlistHistoryEntry[];
}
