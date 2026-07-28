import { describe, expect, it } from "vitest";
import { clamp, daysSince, normalizeText, tokenizeRepo, unique } from "./pipelineUtils.js";
import type { SearchResult } from "../entities/SearchResult.js";

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
