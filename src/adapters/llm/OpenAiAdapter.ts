import OpenAI from "openai";
import type { LlmPort } from "../../ports/LlmPort.js";

export type OpenAiAdapterConfig = {
  openaiApiKey: string | null;
  openaiModel: string;
  claudeApiKey?: string | null;
  claudeModel?: string;
};

/**
 * Implements LlmPort with a dual-provider fallback: Claude first if
 * CLAUDE_API_KEY is configured, otherwise OpenAI. Both providers and their
 * model names are constructor-injected rather than read from process.env
 * internally, matching how GithubAdapter/PrismaAdapter take their config —
 * env-reading belongs at the composition root, not inside the adapter.
 */
export class OpenAiAdapter implements LlmPort {
  private readonly openaiClient: OpenAI | null;
  private readonly openaiModel: string;
  private readonly claudeKey: string | null;
  private readonly claudeModel: string;

  constructor(config: OpenAiAdapterConfig) {
    this.openaiClient = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null;
    this.openaiModel = config.openaiModel;
    this.claudeKey = config.claudeApiKey ?? null;
    this.claudeModel = config.claudeModel ?? "claude-sonnet-4-20250514";
  }

  async generateText(prompt: string): Promise<string> {
    if (this.claudeKey) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.claudeKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.claudeModel,
          max_tokens: 800,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Claude request failed: ${response.status} ${text}`);
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = data.content?.find((item) => item.type === "text")?.text?.trim();
      if (!text) {
        throw new Error("Claude response did not include text content");
      }
      return text;
    }

    if (this.openaiClient) {
      const response = await this.openaiClient.responses.create({
        model: this.openaiModel,
        input: prompt,
      });
      const text = response.output_text?.trim();
      if (!text) {
        throw new Error("OpenAI response did not include text output");
      }
      return text;
    }

    throw new Error("Missing CLAUDE_API_KEY or OPENAI_API_KEY");
  }
}
