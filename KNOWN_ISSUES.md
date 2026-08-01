# Known Issues

Bugs and gaps found during work on this codebase, logged rather than fixed inline so refactor/feature commits stay reviewable. One entry per issue: location, what's wrong, why it wasn't fixed on the spot.

## Persistence / pipeline

- **No snapshot ingestion job exists anywhere** — no cron, no scheduler. `RepoSnapshot` rows only get written when someone runs a search or analyzes a repo. `action-plan-v2.md`'s own Risk 1 calls for a standing ingestion job started alongside the schema, which never happened. This is a real feature (needs a decision on what to track, on what cadence, and where a scheduler runs given this is a CLI-first tool, not a long-running server) — not something to bolt on unilaterally. Decay/velocity data stays sparse and usage-biased until it exists.
- **`decayLabelFor` / `dependencyHealthFor` (`src/domain/usecases/ScoreAndRank.ts`)** — both compute their label from a single data point (current push/release date, current root-contents), not from real historical deltas, despite `RepoSnapshot`/`DependencyMap` existing specifically to support that. `action-plan-v2.md` Phase 8 explicitly says not to build decay logic until snapshot cycles have run — this was built ahead of that prerequisite, and structurally can't be fixed before the ingestion job above exists and has run for weeks. Not wrong, but the confidence the output implies ("Decay: Fading") isn't backed by trend data yet.
- **`OwnerProfile`, `DependencyMap`, `WatchTarget`, `WatchSubscription`, `NotificationEvent`, `SearchHistory`, `TrendSnapshot`** (`prisma/schema.prisma`) — all migrated, zero code references any of them. These back unbuilt features (owner intelligence, dependency risk, watch/notifications, search history, trend radar), not bugs — each is its own scoped piece of work.

## Docs / config

- **`--trends` flag** — documented as a goal in `action-plan-v2.md` Phase 11, does not exist in `src/cli/index.ts`. `--explain` does exist and works. Blocked on `TrendSnapshot` above.
- **Spikes A/B/C** (`action-plan-v2.md`, prerequisites for Phase 1) — README-quality-scoring calibration, dependency-data-source validation, and intent-classification-accuracy testing were never formally run as the structured exercises the plan describes. `reports/SEARCH_CRITERIA_REVIEW_2026-03-30.md` and `reports/SEARCH_AND_NOTIFICATIONS_BRAINSTORM_2026-04-01.md` cover adjacent ground informally but aren't a substitute. These require manual judgment against real repos, not something to run unattended.
