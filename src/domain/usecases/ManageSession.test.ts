import { describe, expect, it } from "vitest";
import { buildSeenEntries, renderSeenRepos, renderShortlistHistory } from "./ManageSession.js";

describe("buildSeenEntries", () => {
  it("builds one entry per full name with a GitHub URL", () => {
    const entries = buildSeenEntries("monitoring tool", ["prometheus/prometheus", "grafana/grafana"]);

    expect(entries).toEqual([
      { prompt: "monitoring tool", fullName: "prometheus/prometheus", url: "https://github.com/prometheus/prometheus" },
      { prompt: "monitoring tool", fullName: "grafana/grafana", url: "https://github.com/grafana/grafana" },
    ]);
  });

  it("returns an empty array for an empty shortlist", () => {
    expect(buildSeenEntries("anything", [])).toEqual([]);
  });
});

describe("renderSeenRepos", () => {
  it("reports nothing seen yet when empty", () => {
    expect(renderSeenRepos([])).toBe("No repos have been shown in this session yet.\n");
  });

  it("numbers and lists each seen repo", () => {
    const text = renderSeenRepos([
      { prompt: "cli tool", fullName: "owner/repo", url: "https://github.com/owner/repo" },
    ]);

    expect(text).toContain("Seen repos:");
    expect(text).toContain("1. cli tool");
    expect(text).toContain("owner/repo");
    expect(text).toContain("https://github.com/owner/repo");
  });
});

describe("renderShortlistHistory", () => {
  it("reports nothing available yet when empty", () => {
    expect(renderShortlistHistory([])).toBe("No shortlist history is available yet.\n");
  });

  it("numbers each past shortlist and lists its repo names", () => {
    const text = renderShortlistHistory([
      {
        prompt: "monitoring tool",
        repos: [
          { prompt: "monitoring tool", fullName: "prometheus/prometheus", url: "https://github.com/prometheus/prometheus" },
          { prompt: "monitoring tool", fullName: "grafana/grafana", url: "https://github.com/grafana/grafana" },
        ],
      },
    ]);

    expect(text).toContain("Shortlist history:");
    expect(text).toContain("1. monitoring tool");
    expect(text).toContain("prometheus/prometheus, grafana/grafana");
  });
});
