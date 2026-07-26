# Hexagon Refactor Plan — reconciling the current codebase with action-plan-v2

Status: proposal, not yet implemented. Written 2026-07-27.

## Why this document exists

Two things are true about this codebase at once:

1. It documents itself as hexagonal architecture (`ARCHITECTURE.md`, `docs/Architecture.md`, `README.md`) — domain isolated from GitHub/Postgres/HTTP/MCP/CLI concerns behind ports.
2. In practice, `src/cli/agent.ts` (~1,290 lines) and `src/cli/stagedSearch.ts` (~890 lines) hold almost all of the product's actual logic — intent parsing, multi-stage retrieval, quality gates, prompt-fit scoring, health scoring, decay/dependency heuristics, composite ranking, session persistence, and LLM calls — none of it behind a port, none of it in `src/domain/`.

Separately, `action-plan-v2.md` describes where the *product* is headed: a 13-phase staged intelligence pipeline (Stage 0–5: intent → broad retrieval → hard gates → prompt-fit → composite ranking → output). Most of Stages 0–4 are already built — just built directly in the CLI adapter instead of behind the hexagon.

This plan defines one target domain shape that satisfies both: it's the same hexagon the docs already promise, and its use cases are named after the pipeline stages action-plan-v2 already committed to. There is no separate "hexagon work" and "pipeline work" — extracting the CLI logic into domain use cases *is* formalizing the pipeline.

## Target domain shape

Five use cases replace the current CLI-embedded logic. Stage numbers match `action-plan-v2.md`'s Phase 2 pipeline-interfaces table.

| Use case | Stage | Input → Output | Replaces (current location) |
|---|---|---|---|
| `ParseIntent` | 0 | prompt string → `ParsedIntent` | `src/cli/intent.ts`: `parseIntent`, `inferFilters`, `detectLanguage`, `buildRetrievalQueries`, `shouldClarifyBeforeSearch` |
| `DiscoverRepos` | 1 | `ParsedIntent` + search params → raw `SearchResult[]` (deduped, merged across multi-query retrieval) | `src/cli/stagedSearch.ts`: the retrieval loop in `runStagedSearch` (lines ~608–619), via existing `RepoApiPort` |
| `ApplyQualityGates` | 2 | candidates + `ParsedIntent` → filtered pool | `src/cli/stagedSearch.ts`: `stage2GateReason`, `ownerTierFor`, `minimumStarsFor`, `domainFreshnessThresholds` |
| `ScoreAndRank` | 3–4 | filtered pool + `ParsedIntent` → `RankedRepo[]` with rationale, confidence, health/decay/dependency breakdown | `src/cli/stagedSearch.ts`: `promptFitBreakdown`, `healthBreakdown`, `repoHealthScore`, `freshnessScore`, `decayLabelFor`, `dependencyHealthFor`, `rankingWeights`, `confidenceLabel` — this is the bulk of the file and it's already pure logic; it just needs to move |
| `AnalyzeRepoDeep` | — | selected repo → `RepoContext` + written report | `src/cli/agent.ts`: `buildRepoContext`, `writeAnalysisReport`, `loadScoutSelectionContext` |
| `ManageSession` | — | session ops → `SessionState` | `src/cli/agent.ts`: `loadSessionState`, `saveSessionState`, `buildSeenEntries`, seen/history tracking |

`AnalyzeRepo` and `GetTrending` (already in `src/domain/usecases/`) are untouched — they're the REST/MCP-facing single-repo-lookup path, a different feature surface from the conversational discovery pipeline. They should, as a follow-up, also call the new `RepoIntelligencePort` so snapshot data accumulates from API/MCP usage too — not required for this refactor, noted in Known Gaps below.

`ScoreAndRank` now also owns the `RepoIntelligencePort` calls added in the persistence-wiring change (`saveSnapshot`/`saveHealthScore` per ranked repo) — that side effect moves with the logic that produces the data it persists.

## Ports

Three already exist and need no interface changes, only new call sites:

- `RepoApiPort` → `GithubAdapter`
- `MetricsRepoPort` → `PrismaAdapter`
- `RepoIntelligencePort` → `PrismaAdapter` (added in the persistence-wiring change)

Three are new — these are exactly the I/O the CLI currently does directly with `fs`/`OpenAI` instead of through a port:

```typescript
// ports/SessionStorePort.ts
export interface SessionStorePort {
  load(): Promise<SessionState>;
  save(state: SessionState): Promise<void>;
}

// ports/ReportWriterPort.ts
export interface ReportWriterPort {
  writeAnalysisReport(context: RepoContext): Promise<void>;
  writeScoutResults(results: RankedShortlistItem[], summary: string): Promise<void>;
}

// ports/LlmPort.ts
export interface LlmPort {
  generateText(prompt: string): Promise<string>;
  generateJson<T>(prompt: string, schema: ZodSchema<T>): Promise<T>;
}
```

`LlmPort` is deliberately thin — "give me text back for this prompt." Prompt construction (the `plan()`/`respond()`/`generateClarifyingQuestions()` logic currently in `AiBrain`, and `QueryTranslator.translate()`'s prompt) is business logic, not adapter logic, so it moves into the domain use cases that call the port, not into the adapter itself. `OpenAiAdapter` implements `LlmPort` and absorbs `AiBrain`'s existing dual-provider fallback (Claude via raw fetch if `CLAUDE_API_KEY` is set, else OpenAI) — that's adapter-level infrastructure concern, correctly placed.

`QueryTranslator` (`src/ai/QueryTranslator.ts`) and `AiBrain` (`src/cli/agent.ts`) currently duplicate LLM plumbing (separate OpenAI client construction, separate JSON-extraction logic). Collapsing both onto one `LlmPort`/`OpenAiAdapter` removes that duplication as a side effect.

## Adapters

New adapters, one per new port:

- `FileSessionStore implements SessionStorePort` — wraps the existing `.codex/session.json` read/write
- `MarkdownReportWriter implements ReportWriterPort` — wraps the existing `reports/REPO_ANALYSIS.md` / `reports/REPO_SCOUT_RESULTS.md` writes
- `OpenAiAdapter implements LlmPort` — wraps OpenAI + the Claude fallback

`GithubAdapter` and `PrismaAdapter` need no structural changes — they're called from new use cases instead of directly from `agent.ts`, but their interfaces stay as-is.

## What stays in `src/cli/`

After extraction, the CLI layer should contain only:

- Composition root wiring (`main()` in `agent.ts` and `index.ts`) — identical in spirit to the existing `src/index.ts` wiring for the REST/MCP surfaces
- `readline` prompt handling
- `chalk`/`cli-table3` rendering of use-case output
- Commander option parsing (`src/cli/index.ts`)

Everything that currently computes something (a score, a filter decision, a rationale string) moves to domain. Everything that currently touches the outside world directly (`fs`, `OpenAI`, `execSync` for opening a browser) moves behind a port.

## Extraction order (unchanged from earlier agreement, restated against the real stage names)

Each step: characterization test on current behavior → move code → unit tests against mocked ports → `tsc --noEmit` clean → one commit.

1. `ParseIntent` — smallest, pure logic, zero ports. Proves the extraction pattern.
2. `ManageSession` + `SessionStorePort` + `FileSessionStore` — smallest port, proves the port/adapter pattern cheaply.
3. `DiscoverRepos` + `ApplyQualityGates` — both consume `RepoApiPort`, which already exists.
4. `ScoreAndRank` — the largest single extraction (absorbs most of `stagedSearch.ts`), including the `RepoIntelligencePort` calls it now owns.
5. `AnalyzeRepoDeep` + `ReportWriterPort`/`MarkdownReportWriter` + `LlmPort`/`OpenAiAdapter` — largest port surface, done last once the pattern is well-proven.

Branch: `refactor/hexagon-cleanup` off `main`. Vitest as test runner (already agreed, not yet installed).

## Known gaps this refactor does not close

Logged here rather than fixed inline, per the pure-refactor discipline for this effort — see `KNOWN_ISSUES.md` for the tracked list:

- `OwnerProfile`, `DependencyMap`, `WatchTarget`, `WatchSubscription`, `NotificationEvent`, `SearchHistory`, `TrendSnapshot` remain unwired — schema exists, no code touches them (action-plan-v2 Phases 7 persistence, 9, 12, 13).
- No snapshot ingestion job/scheduler exists. `RepoSnapshot` only grows when someone runs a search — action-plan-v2's own Risk 1 wants a standing ingestion job, not opportunistic writes.
- Decay (`decayLabelFor`) and dependency health (`dependencyHealthFor`) are still single-point heuristics today; they'll only reflect real trend data once enough `RepoSnapshot` history accumulates (weeks, per action-plan-v2 Phase 8's own prerequisite).
- Spikes A (README scoring calibration), B (dependency data source), and C (intent classification accuracy) — action-plan-v2's own prerequisites for Phase 1 — were never formally run in the structured way the plan describes, though the `SEARCH_CRITERIA_REVIEW` and `SEARCH_AND_NOTIFICATIONS_BRAINSTORM` reports cover adjacent ground informally.
- `--trends` flag (Phase 11) does not exist; `--explain` does.
- `AnalyzeRepo`/`GetTrending` (REST/MCP path) don't write to `RepoIntelligencePort` — only the CLI staged-search path does, so snapshot history is CLI-usage-biased.
