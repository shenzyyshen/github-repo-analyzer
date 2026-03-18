import OpenAI from "openai";
import { z } from "zod";

const TranslationSchema = z.object({
  query: z.string().min(1),
  language: z.string().optional().nullable(),
  minStars: z.number().int().nonnegative().optional().nullable(),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  sort: z.enum(["stars", "updated", "forks"]).optional().nullable(),
});

export type QueryTranslation = z.infer<typeof TranslationSchema>;

export class QueryTranslator {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, model = "gpt-3.5-turbo") {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async translate(userQuery: string): Promise<QueryTranslation> {
    const prompt = [
      "You translate user intent into GitHub repository search parameters.",
      "Return JSON only with fields:",
      '{ "query": string, "language": string|null, "minStars": number|null, "since": "YYYY-MM-DD"|null, "sort": "stars"|"updated"|"forks"|null }',
      "Rules:",
      "- query is concise keywords suitable for GitHub search.",
      "- language should be a single language name when clear, otherwise null.",
      "- minStars should be 0 if no constraint is implied.",
      "- since should be a date when recency is implied (e.g. last 90 days), otherwise null.",
      "- sort should be the best default for the intent (stars for popularity, updated for freshness).",
      "",
      `User: ${userQuery}`,
    ].join("\n");

    try {
      const response = await this.client.responses.create({
        model: this.model,
        input: prompt,
      });

      const text = response.output_text?.trim() ?? "";
      const json = this.extractJson(text);
      return TranslationSchema.parse(json);
    } catch (_err) {
      console.warn("AI translation unavailable, using raw query");
      return {
        query: userQuery,
        language: null,
        minStars: 0,
        since: null,
        sort: "stars",
      };
    }
  }

  private extractJson(text: string): unknown {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("AI response did not include valid JSON");
    }
    const slice = text.slice(start, end + 1);
    return JSON.parse(slice);
  }
}
