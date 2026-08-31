import type { SeenRepoEntry, ShortlistHistoryEntry } from "../entities/SessionState.js";

function buildRepoUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

/**
 * Builds seen-repo entries for everything in a shortlist, keyed to the prompt
 * that produced it. Takes just the full names a shortlist ranked, not the
 * ranked/scored shape itself — that type belongs to the not-yet-extracted
 * shortlist-rendering logic, and this function never needed more than the name.
 */
export function buildSeenEntries(prompt: string, shortlistFullNames: string[]): SeenRepoEntry[] {
  return shortlistFullNames.map((fullName) => ({
    prompt,
    fullName,
    url: buildRepoUrl(fullName),
  }));
}

export function renderSeenRepos(entries: SeenRepoEntry[]): string {
  if (entries.length === 0) {
    return "No repos have been shown in this session yet.\n";
  }

  return [
    "Seen repos:",
    ...entries.map((entry, index) => `${index + 1}. ${entry.prompt}\n   ${entry.fullName}\n   ${entry.url}`),
    "",
  ].join("\n");
}

export function renderShortlistHistory(entries: ShortlistHistoryEntry[]): string {
  if (entries.length === 0) {
    return "No shortlist history is available yet.\n";
  }

  return [
    "Shortlist history:",
    ...entries.map((entry, index) => `${index + 1}. ${entry.prompt}\n   ${entry.repos.map((repo) => repo.fullName).join(", ")}`),
    "",
  ].join("\n");
}
