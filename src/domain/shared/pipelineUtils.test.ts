import { describe, expect, it } from "vitest";
import {
  clamp,
  daysSince,
  domainFreshnessThresholds,
  keywordOverlap,
  normalizeText,
  ownerTierFor,
  ownerTierScore,
  tokenizeRepo,
  unique,
} from "./pipelineUtils.js";
import type { SearchResult } from "../entities/SearchResult.js";
import { parseIntent } from "../usecases/ParseIntent.js";

describe("normalizeText", () => {
  it("lowercases, strips punctuation, and splits on whitespace", () => {
    expect(normalizeText("Self-Hosted, Monitoring!")).toEqual(["self-hosted", "monitoring"]);
  });
});

describe("unique", () => {
  it("dedupes while preserving first-seen order", () => {
    expect(unique(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
});

describe("clamp", () => {
  it("clamps to the default 0-1 range", () => {
    expect(clamp(1.5)).toBe(1);
    expect(clamp(-0.5)).toBe(0);
    expect(clamp(0.5)).toBe(0.5);
  });

  it("respects custom bounds", () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
});

describe("daysSince", () => {
  it("returns Infinity for a missing date", () => {
    expect(daysSince(null)).toBe(Number.POSITIVE_INFINITY);
    expect(daysSince(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns whole days elapsed for a past date", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    expect(daysSince(tenDaysAgo)).toBe(10);
  });
});

const baseRepo: SearchResult = {
  owner: "acme",
  name: "widget",
  fullName: "acme/widget",
  description: "A self-hosted widget",
  stars: 100,
  forks: 10,
  archived: false,
  isFork: false,
  language: "TypeScript",
  createdAt: new Date("2024-01-01"),
  pushedAt: new Date("2024-06-01"),
  topics: ["widgets", "self-hosted"],
};

describe("tokenizeRepo", () => {
  it("tokenizes name, description, language, and topics", () => {
    const tokens = tokenizeRepo(baseRepo, null);
    expect(tokens.has("widget")).toBe(true);
    expect(tokens.has("self-hosted")).toBe(true);
    expect(tokens.has("typescript")).toBe(true);
    expect(tokens.has("widgets")).toBe(true);
  });

  it("includes readme tokens when a readme is provided", () => {
    const tokens = tokenizeRepo(baseRepo, "Deploy with Docker Compose");
    expect(tokens.has("docker")).toBe(true);
  });
});

describe("ownerTierFor", () => {
  it("ranks a known elite owner as Elite regardless of stars", () => {
    expect(ownerTierFor({ ...baseRepo, owner: "anthropic", stars: 10 })).toBe("Elite");
  });

  it("ranks a high-star unknown owner as Elite by star threshold", () => {
    expect(ownerTierFor({ ...baseRepo, owner: "randodev", stars: 60_000 })).toBe("Elite");
  });

  it("ranks a mid-star owner as Strong", () => {
    expect(ownerTierFor({ ...baseRepo, owner: "randodev", stars: 6_000 })).toBe("Strong");
  });

  it("ranks a low-signal, inactive owner as Weak", () => {
    expect(
      ownerTierFor({ ...baseRepo, owner: "randodev", stars: 5, forks: 0, pushedAt: new Date("2020-01-01") })
    ).toBe("Weak");
  });
});

describe("ownerTierScore", () => {
  it("orders tiers Elite > Strong > Promising > Weak", () => {
    expect(ownerTierScore("Elite")).toBeGreaterThan(ownerTierScore("Strong"));
    expect(ownerTierScore("Strong")).toBeGreaterThan(ownerTierScore("Promising"));
    expect(ownerTierScore("Promising")).toBeGreaterThan(ownerTierScore("Weak"));
  });
});

describe("domainFreshnessThresholds", () => {
  it("returns tighter thresholds for fast-moving domains than slow ones", () => {
    const fast = domainFreshnessThresholds("fast");
    const slow = domainFreshnessThresholds("slow");
    expect(fast.disqualify).toBeLessThan(slow.disqualify);
  });
});

describe("keywordOverlap", () => {
  it("returns 0 when the intent carries no purpose/concept terms", () => {
    const intent = parseIntent("x");
    expect(keywordOverlap(intent, baseRepo, null)).toBe(0);
  });

  it("returns a positive overlap when repo text matches intent terms", () => {
    const intent = parseIntent("self-hosted widget");
    const overlap = keywordOverlap(intent, baseRepo, null);
    expect(overlap).toBeGreaterThan(0);
  });
});
