import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "./FileSessionStore.js";

describe("FileSessionStore", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "session-store-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns an empty session when no file exists yet", async () => {
    const store = new FileSessionStore();
    const state = await store.load();
    expect(state).toEqual({ seenRepos: [], shortlistHistory: [] });
  });

  it("round-trips a saved session", async () => {
    const store = new FileSessionStore();
    const state = {
      seenRepos: [{ prompt: "cli tool", fullName: "owner/repo", url: "https://github.com/owner/repo" }],
      shortlistHistory: [{ prompt: "cli tool", repos: [] as never[] }],
    };

    await store.save(state);
    const loaded = await store.load();

    expect(loaded).toEqual(state);
  });

  it("falls back to an empty session when the file has malformed shape", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(".codex", { recursive: true });
    await writeFile(".codex/session.json", JSON.stringify({ seenRepos: "not-an-array" }), "utf8");

    const store = new FileSessionStore();
    const state = await store.load();

    expect(state).toEqual({ seenRepos: [], shortlistHistory: [] });
  });
});
