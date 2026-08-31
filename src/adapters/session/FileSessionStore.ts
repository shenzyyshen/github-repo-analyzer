import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { SessionState } from "../../domain/entities/SessionState.js";
import type { SessionStorePort } from "../../ports/SessionStorePort.js";

const SESSION_DIR = ".codex";
const SESSION_FILE = ".codex/session.json";

export class FileSessionStore implements SessionStorePort {
  async load(): Promise<SessionState> {
    try {
      const raw = await readFile(SESSION_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionState>;
      return {
        seenRepos: Array.isArray(parsed.seenRepos) ? parsed.seenRepos : [],
        shortlistHistory: Array.isArray(parsed.shortlistHistory) ? parsed.shortlistHistory : [],
      };
    } catch {
      return { seenRepos: [], shortlistHistory: [] };
    }
  }

  async save(state: SessionState): Promise<void> {
    await mkdir(SESSION_DIR, { recursive: true });
    await writeFile(SESSION_FILE, JSON.stringify(state, null, 2), "utf8");
  }
}
