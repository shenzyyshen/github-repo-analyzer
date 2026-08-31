import { describe, expect, it } from "vitest";
import { applyQualityGates, stage2GateReason } from "./ApplyQualityGates.js";
import { parseIntent } from "./ParseIntent.js";
import type { EnrichedRepo } from "./DiscoverRepos.js";
import type { SearchResult } from "../entities/SearchResult.js";
import type { IntentClassification } from "../entities/IntentClassification.js";

function makeRepo(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
    description: "A self-hosted widget monitoring tool",
    stars: 500,
    forks: 20,
    archived: false,
    isFork: false,
    language: "TypeScript",
    createdAt: new Date("2024-01-01"),
    pushedAt: new Date(),
    topics: ["monitoring"],
    ...overrides,
  };
}

const goodReadme = "# Widget\nA self-hosted monitoring widget for websites and APIs. ".repeat(10);

function makeEnriched(overrides: Partial<EnrichedRepo> = {}): EnrichedRepo {
  return {
    search: makeRepo(),
    metrics: null,
    readme: goodReadme,
    rootContents: [],
    latestRelease: null,
    analysisError: null,
    ...overrides,
  };
}

const classification: IntentClassification = {
  artifactType: "tool",
  domainSpeed: "medium",
  specificity: "broad",
  intentMode: "best_shortlist",
  freshnessOverride: "none",
  ownerPreference: "any",
  confidence: 0.8,
};

const intent = parseIntent("self-hosted monitoring widget");

describe("stage2GateReason", () => {
  it("passes a healthy, active, well-documented repo", () => {
    expect(stage2GateReason(makeEnriched(), classification, intent, "Strong")).toBeNull();
  });

  it("rejects an archived repo", () => {
    const repo = makeEnriched({ search: makeRepo({ archived: true }) });
    expect(stage2GateReason(repo, classification, intent, "Strong")).toBe("archived");
  });

  it("rejects a fork", () => {
    const repo = makeEnriched({ search: makeRepo({ isFork: true }) });
    expect(stage2GateReason(repo, classification, intent, "Strong")).toBe("fork");
  });

  it("rejects a repo with no README unless the owner is Elite with enough stars", () => {
    const repo = makeEnriched({ readme: null });
    expect(stage2GateReason(repo, classification, intent, "Strong")).toBe("missing README");
    expect(
      stage2GateReason({ ...repo, search: makeRepo({ stars: 50_000 }) }, classification, intent, "Elite")
    ).toBeNull();
  });

  it("rejects a repo with a too-thin README", () => {
    const repo = makeEnriched({ readme: "short" });
    expect(stage2GateReason(repo, classification, intent, "Strong")).toBe("README too thin");
  });

  it("rejects a repo whose name, description, and README don't overlap the prompt", () => {
    const repo = makeEnriched({
      search: makeRepo({
        fullName: "acme/zephyr",
        name: "zephyr",
        description: "A physics simulation engine",
        topics: ["physics", "simulation"],
      }),
      readme: "Completely unrelated content about something else entirely. ".repeat(10),
    });
    expect(stage2GateReason(repo, classification, intent, "Strong")).toBe("README/prompt overlap too weak");
  });

  it("rejects a repo stale beyond the domain's disqualify threshold", () => {
    const repo = makeEnriched({ search: makeRepo({ pushedAt: new Date("2015-01-01") }) });
    expect(stage2GateReason(repo, classification, intent, "Strong")).toBe("stale for domain");
  });

  it("rejects a repo below the domain-appropriate star floor", () => {
    const repo = makeEnriched({ search: makeRepo({ stars: 0, forks: 0 }) });
    expect(stage2GateReason(repo, classification, intent, "Weak")).toBe("below star floor");
  });
});

describe("applyQualityGates", () => {
  it("keeps only candidates with no gate reason", () => {
    const passing = makeEnriched();
    const failing = makeEnriched({ search: makeRepo({ fullName: "acme/dead", archived: true }) });

    const result = applyQualityGates([passing, failing], classification, intent);

    expect(result).toHaveLength(1);
    expect(result[0].search.fullName).toBe("acme/widget");
  });
});
