# Known Issues

Bugs and gaps found during work on this codebase, logged rather than fixed inline so refactor/feature commits stay reviewable. One entry per issue: location, what's wrong, why it wasn't fixed on the spot.

## Persistence / pipeline

- **`AnalyzeRepo`/`GetTrending` don't write to `RepoIntelligencePort`.** Only the discovery pipeline (`src/domain/usecases/SearchRepos.ts` → `ScoreAndRank`) writes `RepoSnapshot`/`RepoHealthScore`. Means snapshot history only accumulates from CLI/MCP `search_repos` usage, not from `analyze_repo`/`get_trending` calls. Found while wiring persistence, 2026-07-27.
- **No snapshot ingestion job exists anywhere** — no cron, no scheduler. `RepoSnapshot` rows only get written opportunistically when a user runs a search. `action-plan-v2.md`'s own Risk 1 calls for a standing ingestion job started alongside the schema, which never happened. Decay/velocity data will be sparse and usage-biased until this exists.
- **`decayLabelFor` / `dependencyHealthFor` (`src/domain/usecases/ScoreAndRank.ts`)** — both compute their label from a single data point (current push/release date, current root-contents), not from real historical deltas, despite `RepoSnapshot`/`DependencyMap` existing specifically to support that. `action-plan-v2.md` Phase 8 explicitly says not to build decay logic until snapshot cycles have run — this was built ahead of that prerequisite. Not wrong, but the confidence the output implies ("Decay: Fading") isn't backed by trend data yet.
- **`OwnerProfile`, `DependencyMap`, `WatchTarget`, `WatchSubscription`, `NotificationEvent`, `SearchHistory`, `TrendSnapshot`** (`prisma/schema.prisma`) — all migrated, zero code references any of them.

## Docs / config

- **`--trends` flag** — documented as a goal in `action-plan-v2.md` Phase 11, does not exist in `src/cli/index.ts`. `--explain` does exist and works.
- **Spikes A/B/C** (`action-plan-v2.md`, prerequisites for Phase 1) — README-quality-scoring calibration, dependency-data-source validation, and intent-classification-accuracy testing were never formally run as the structured exercises the plan describes. `reports/SEARCH_CRITERIA_REVIEW_2026-03-30.md` and `reports/SEARCH_AND_NOTIFICATIONS_BRAINSTORM_2026-04-01.md` cover adjacent ground informally but aren't a substitute.

## Correctness

- **`alternativesNote` slices the trimmed results array, not the full ranked pool (`src/domain/usecases/SearchRepos.ts`).** `arr.slice(1, 4)` inside the `.map` over the already-trimmed `results` — same shape as the confidence bug fixed 2026-08-01 (`9c2ec15`). In `best_match` mode `arr` has length 1, so `closeAlternatives` is always empty and `alternativesNote` is always `null`, even when there's a real, close rank-2 candidate worth mentioning. Not fixed alongside the confidence bug because it's a distinct, unreported feature gap rather than an inverted signal — flagged here for a deliberate follow-up rather than folded in silently.

## Dead code

- **`generateClarifyingQuestions` (`src/domain/usecases/ParseIntent.ts`, moved from `src/cli/intent.ts`)** — a rule-based clarifying-question generator, exported but never called anywhere in the codebase. `AiBrain.generateClarifyingQuestions` (`src/cli/agent.ts`, LLM-based, via the injected `LlmPort`) is what's actually wired in at the call site. Found during the `ParseIntent` extraction, 2026-07-27; ported as-is to keep that extraction a pure move rather than deciding here whether the rule-based version should be deleted or revived as an LLM fallback.
