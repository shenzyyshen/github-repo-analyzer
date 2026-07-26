import { describe, expect, it } from "vitest";
import {
  buildClarificationPrompt,
  buildRetrievalQueries,
  createSessionPreferences,
  detectLanguage,
  generateClarifyingQuestions,
  inferFilters,
  normalizeSearchQuery,
  parseIntent,
  renderAppliedFilters,
  shouldClarifyBeforeSearch,
  type SearchInput,
} from "./ParseIntent.js";

const baseSearch: SearchInput = {
  query: "",
  language: null,
  minStars: 0,
  since: null,
  license: null,
  sort: "stars",
  top: 5,
  random: false,
};

describe("detectLanguage", () => {
  it("detects a named language", () => {
    expect(detectLanguage("a python cli tool")).toBe("Python");
    expect(detectLanguage("typescript web framework")).toBe("TypeScript");
  });

  it("returns null when no language is mentioned", () => {
    expect(detectLanguage("a tool for managing repos")).toBeNull();
  });
});

describe("normalizeSearchQuery", () => {
  it("strips stop words and lowercases", () => {
    expect(normalizeSearchQuery("I want a CLI tool for managing repos")).toBe("cli managing");
  });
});

describe("parseIntent", () => {
  it("extracts language, maturity signals, and concepts from a rich prompt", () => {
    const intent = parseIntent("I want a lightweight production-ready self-hosted monitoring tool in Python");

    expect(intent.language).toBe("Python");
    expect(intent.maturitySignals).toEqual(expect.arrayContaining(["lightweight", "production-ready"]));
    expect(intent.concepts).toContain("self-hosted");
    expect(intent.concepts).toContain("monitoring");
    expect(intent.confidence).toBeGreaterThan(0);
  });

  it("computes since from a recency phrase", () => {
    const intent = parseIntent("actively maintained websocket library");
    expect(intent.since).not.toBeNull();
    expect(intent.concepts).toContain("realtime");
  });

  it("returns low confidence for a vague prompt", () => {
    const intent = parseIntent("something cool");
    expect(intent.confidence).toBeLessThan(0.4);
  });
});

describe("inferFilters", () => {
  it("applies language and maturity filters derived from the prompt", () => {
    const { search, applied, intent } = inferFilters(
      "production-ready typescript rest api",
      baseSearch
    );

    expect(search.language).toBe("TypeScript");
    expect(search.minStars).toBeGreaterThanOrEqual(1000);
    expect(applied.some((line) => line.startsWith("Language:"))).toBe(true);
    expect(applied.some((line) => line.includes("production-ready"))).toBe(true);
    expect(intent.concepts).toContain("rest-api");
  });

  it("preserves an explicitly set language over a detected one", () => {
    const { search, applied } = inferFilters("python tool", { ...baseSearch, language: "Go" });
    expect(search.language).toBe("Go");
    expect(applied).toContain("Language: Go");
  });
});

describe("buildRetrievalQueries", () => {
  it("returns at least the base query and caps at 5 variants", () => {
    const intent = parseIntent("self-hosted monitoring dashboard for apis and websites");
    const queries = buildRetrievalQueries(intent, "monitoring dashboard");

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(5);
    expect(queries).toContain("monitoring dashboard");
  });
});

describe("shouldClarifyBeforeSearch", () => {
  it("asks to clarify when confidence is low and structure is thin", () => {
    const intent = parseIntent("something cool");
    expect(shouldClarifyBeforeSearch(intent)).toBe(true);
  });

  it("does not clarify when the prompt has enough structure", () => {
    const intent = parseIntent("production-ready typescript rest api updated within 6 months");
    expect(shouldClarifyBeforeSearch(intent)).toBe(false);
  });
});

describe("buildClarificationPrompt", () => {
  it("asks for a category when nothing concrete was found", () => {
    const intent = parseIntent("something cool");
    expect(buildClarificationPrompt(intent)).toMatch(/repo type|category/i);
  });
});

describe("renderAppliedFilters", () => {
  it("returns an empty string when nothing was applied", () => {
    expect(renderAppliedFilters([])).toBe("");
  });

  it("renders a bulleted list when filters were applied", () => {
    const text = renderAppliedFilters(["Language: Python"]);
    expect(text).toContain("Applied filters:");
    expect(text).toContain("- Language: Python");
  });
});

describe("createSessionPreferences", () => {
  it("returns the documented defaults", () => {
    const prefs = createSessionPreferences();
    expect(prefs.minStars).toBe(500);
    expect(prefs.skipped.size).toBe(0);
  });
});

describe("generateClarifyingQuestions", () => {
  it("returns between 2 and 6 questions for a vague prompt", () => {
    const intent = parseIntent("something cool");
    const prefs = createSessionPreferences();
    const questions = generateClarifyingQuestions(intent, "something cool", prefs);

    expect(questions.length).toBeGreaterThanOrEqual(2);
    expect(questions.length).toBeLessThanOrEqual(6);
  });

  it("skips questions whose key is already dismissed", () => {
    const intent = parseIntent("something cool");
    const prefs = createSessionPreferences();
    prefs.skipped.add("maturity");
    prefs.skipped.add("freshness");
    const questions = generateClarifyingQuestions(intent, "something cool", prefs);

    expect(questions.some((q) => q.key === "maturity")).toBe(false);
    expect(questions.some((q) => q.key === "freshness")).toBe(false);
  });
});
