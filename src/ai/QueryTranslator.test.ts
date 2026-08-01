import { describe, expect, it, vi } from "vitest";
import { QueryTranslator } from "./QueryTranslator.js";
import type { LlmPort } from "../ports/LlmPort.js";

function makeMockLlmPort(response: string): LlmPort {
  return { generateText: vi.fn().mockResolvedValue(response) };
}

describe("QueryTranslator.translate", () => {
  it("parses a well-formed JSON response from the LLM", async () => {
    const llmPort = makeMockLlmPort(
      '{ "query": "monitoring dashboard", "language": "TypeScript", "minStars": 500, "since": "2026-01-01", "sort": "stars" }'
    );
    const translator = new QueryTranslator(llmPort);

    const result = await translator.translate("a typescript monitoring dashboard");

    expect(result).toEqual({
      query: "monitoring dashboard",
      language: "TypeScript",
      minStars: 500,
      since: "2026-01-01",
      sort: "stars",
    });
  });

  it("extracts JSON even when the model wraps it in prose", async () => {
    const llmPort = makeMockLlmPort(
      'Sure, here you go:\n{ "query": "cli tool", "language": null, "minStars": 0, "since": null, "sort": null }\nLet me know if that helps.'
    );
    const translator = new QueryTranslator(llmPort);

    const result = await translator.translate("a cli tool");

    expect(result.query).toBe("cli tool");
  });

  it("falls back to the raw query when the LLM call fails", async () => {
    const llmPort: LlmPort = { generateText: vi.fn().mockRejectedValue(new Error("rate limited")) };
    const translator = new QueryTranslator(llmPort);

    const result = await translator.translate("self-hosted monitoring");

    expect(result).toEqual({
      query: "self-hosted monitoring",
      language: null,
      minStars: 0,
      since: null,
      sort: "stars",
    });
  });

  it("falls back to the raw query when the response isn't valid JSON", async () => {
    const llmPort = makeMockLlmPort("not json at all");
    const translator = new QueryTranslator(llmPort);

    const result = await translator.translate("raw fallback query");

    expect(result.query).toBe("raw fallback query");
    expect(result.sort).toBe("stars");
  });

  it("falls back when the JSON doesn't match the expected schema", async () => {
    const llmPort = makeMockLlmPort('{ "query": "x", "since": "not-a-date" }');
    const translator = new QueryTranslator(llmPort);

    const result = await translator.translate("schema mismatch query");

    expect(result.query).toBe("schema mismatch query");
  });
});
