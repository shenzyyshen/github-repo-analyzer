/**
 * Port (interface) for generating text from a large language model.
 * Implemented by adapters (e.g. OpenAI/Claude); used by use cases.
 * Deliberately thin — prompt construction and response parsing are
 * business logic and stay in the caller, not the adapter.
 */
export interface LlmPort {
  generateText(prompt: string): Promise<string>;
}
