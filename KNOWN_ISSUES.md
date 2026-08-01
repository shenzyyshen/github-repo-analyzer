# Known Issues

Bugs and gaps found during work on this codebase, logged rather than fixed inline so refactor/feature commits stay reviewable. One entry per issue: location, what's wrong, why it wasn't fixed on the spot.

## Persistence / pipeline

- **`src/cli/agent.ts` (AnalyzeRepo/GetTrending REST+MCP path)** — `src/domain/usecases/AnalyzeRepo.ts` and `GetTrending.ts` never call `RepoIntelligencePort`. Only the CLI staged-search path (`stagedSearch.ts:runStagedSearch`) writes `RepoSnapshot`/`RepoHealthScore`. Means snapshot history only accumulates from CLI usage, not API/MCP usage. Found while wiring persistence, 2026-07-27.
- **No snapshot ingestion job exists anywhere** — no cron, no scheduler. `RepoSnapshot` rows only get written opportunistically when a user runs a search. `action-plan-v2.md`'s own Risk 1 calls for a standing ingestion job started alongside the schema, which never happened. Decay/velocity data will be sparse and usage-biased until this exists.
- **`decayLabelFor` / `dependencyHealthFor` (`src/cli/stagedSearch.ts`)** — both compute their label from a single data point (current push/release date, current root-contents), not from real historical deltas, despite `RepoSnapshot`/`DependencyMap` existing specifically to support that. `action-plan-v2.md` Phase 8 explicitly says not to build decay logic until snapshot cycles have run — this was built ahead of that prerequisite. Not wrong, but the confidence the output implies ("Decay: Fading") isn't backed by trend data yet.
- **`OwnerProfile`, `DependencyMap`, `WatchTarget`, `WatchSubscription`, `NotificationEvent`, `SearchHistory`, `TrendSnapshot`** (`prisma/schema.prisma`) — all migrated, zero code references any of them.

## Docs / config

- **`.env.example`** — missing `CLAUDE_API_KEY` and `CLAUDE_MODEL`. `AiBrain` (`src/cli/agent.ts:854-862`) actually uses them (falls back to Anthropic's API via raw `fetch` when `CLAUDE_API_KEY` is set, before falling back to OpenAI) — this dual-provider behavior is undocumented, someone reading `.env.example` would never discover it.
- **`--trends` flag** — documented as a goal in `action-plan-v2.md` Phase 11, does not exist in `src/cli/index.ts`. `--explain` does exist and works.
- **Spikes A/B/C** (`action-plan-v2.md`, prerequisites for Phase 1) — README-quality-scoring calibration, dependency-data-source validation, and intent-classification-accuracy testing were never formally run as the structured exercises the plan describes. `reports/SEARCH_CRITERIA_REVIEW_2026-03-30.md` and `reports/SEARCH_AND_NOTIFICATIONS_BRAINSTORM_2026-04-01.md` cover adjacent ground informally but aren't a substitute.

## Correctness

- **Per-row confidence labels are inverted (`src/domain/usecases/SearchRepos.ts:130`)** — `const gap = index === 0 && arr[1] ? result.finalScore - arr[1].finalScore : 0.1;` computes a real score gap only for rank 1; every other row gets a hardcoded `0.1`, which exceeds `CONFIDENCE_THRESHOLDS.high.minGap` (0.08). Result: ranks 2+ are handed "High" confidence unconditionally whenever the stage-3 pool is large enough, while rank 1 is the only honestly-evaluated row. Observed live on 2026-08-01 via MCP `search_repos` for "self-hosted uptime monitoring dashboard": rank 1 `apache/hertzbeat` = **Low**, ranks 2–3 = **High**.

  Root cause is conceptual, not a typo: `action-plan-v2.md` defines confidence as a property of the *result set* ("Rank 1 score > 80 AND gap to rank 2 > 10 points → High"), but the code applies it per row. The fix is to compute one confidence label for the search and attach it to the result set, not to each entry — which is a behavior change, so it was left for a deliberate pass rather than folded into a refactor commit. Now higher priority than before, because the MCP surface feeds this label to a model that will act on it.

## Structure

- **`classifyIntent` / `inferArtifactType` (`src/cli/stagedSearch.ts`)** — Stage 0 classification logic still living in a CLI file rather than alongside `ParseIntent` in the domain. Never explicitly scoped into the hexagon-refactor plan, so it was left in place rather than folded in silently. Everything else it touches is already extracted, so this is a small, self-contained follow-up.

## Dead code

- **`generateClarifyingQuestions` (`src/domain/usecases/ParseIntent.ts`, moved from `src/cli/intent.ts`)** — a rule-based clarifying-question generator, exported but never called anywhere in the codebase. `AiBrain.generateClarifyingQuestions` (`src/cli/agent.ts:953`, LLM-based) is what's actually wired in at the call site (`agent.ts:1127`). Found during the `ParseIntent` extraction, 2026-07-27; ported as-is to keep that extraction a pure move rather than deciding here whether the rule-based version should be deleted or revived as an LLM fallback.

## Duplication

- **`src/ai/QueryTranslator.ts` and `AiBrain` (`src/cli/agent.ts`)** duplicate LLM plumbing — separate `OpenAI` client construction, separate ad-hoc JSON-extraction from response text. Slated to collapse onto a single `LlmPort`/`OpenAiAdapter` in the hexagon refactor (see `docs/HEXAGON-REFACTOR-PLAN.md`), not fixed standalone.
