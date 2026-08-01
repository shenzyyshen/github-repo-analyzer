# Architecture — GitHub Repo Analyzer

This project uses **Hexagonal (Ports & Adapters)** architecture: business logic lives in `src/domain/`, depends only on port interfaces, and never imports a concrete adapter, HTTP framework, database client, or terminal library.

The product is a **terminal-first GitHub repo scout** that turns a natural-language request into a ranked, explained shortlist of repositories, plus a deep-analysis report for any repo you pick.

> **Status note.** This document describes the code as it actually is. Where something is planned-but-not-built, or built-but-not-trustworthy, it says so explicitly — see [Known Gaps](#known-gaps) and `KNOWN_ISSUES.md`. Two subsystems in this repo sit at different levels of maturity; [Two Subsystems](#two-subsystems) explains the split.

---

## Two Subsystems

This repo contains two related but distinct systems. Conflating them leads to overclaiming, so they're separated here.

**1. The staged discovery pipeline (CLI-only).** Natural-language search → multi-query retrieval → quality gates → prompt-fit scoring → composite ranking → shortlist. Fully extracted into domain use cases. Reachable via `npm run repo` (conversational agent) and `npm run cli -- search` (direct command). **It has no REST or MCP surface.**

**2. Single-repo lookup (REST + MCP + CLI).** `AnalyzeRepo` and `GetTrending` — fetch one repo's metrics, or list trending repos. These run unmodified across three delivery surfaces via constructor injection in `src/index.ts`. This is the part where "same core logic, multiple transports" is literally true.

---

## Layers

### Domain (`src/domain/`)

The business core. Zero imports from adapters, Express, Prisma, Octokit, OpenAI, or chalk.

**Use cases** (`src/domain/usecases/`):

| Use case | Stage | Responsibility |
|---|---|---|
| `ParseIntent` | 0 | Prompt string → `ParsedIntent` (language, license, activity, maturity signals, domain concepts, retrieval-query variants). Pure logic, no ports. |
| `DiscoverRepos` | 1 | Multi-query retrieval, merge/dedup (200-candidate cap), preselection, enrichment (README/root-contents/release/metrics). |
| `ApplyQualityGates` | 2 | Drops archived, forks, missing/thin READMEs, weak prompt overlap, stale-for-domain, below-star-floor. |
| `ScoreAndRank` | 3–4 | Prompt-fit scoring, health score, freshness, decay, dependency health, domain-speed-weighted composite ranking. Persists snapshot + health-score rows. |
| `AnalyzeRepoDeep` | — | Deep-dive on one selected repo → `RepoContext` + markdown analysis report. |
| `ManageSession` | — | `seen` / `history` recall entries and their rendering. |
| `AnalyzeRepo` | — | Single-repo metrics + 24h star growth. Used by REST, MCP, and the pipeline's enrichment step. |
| `GetTrending` | — | Trending repos by recent star growth. Used by REST and MCP. |

**Entities** (`src/domain/entities/`): `Repo`, `Metrics`, `SearchResult`, `TrendingRepo`, `SessionState`, `RepoSnapshot`, `RepoHealthScoreRecord`, `IntentClassification` (the pipeline's shared classification vocabulary — artifact type, domain speed, owner tier, decay label, etc.).

**Shared** (`src/domain/shared/pipelineUtils.ts`): pure helpers used across multiple stages — text normalization, repo tokenization, owner-tier classification, freshness thresholds, keyword overlap.

### Ports (`src/ports/`)

Interfaces only, no implementation.

| Port | Purpose |
|---|---|
| `RepoApiPort` | Repo metadata, languages, issues, contributors, search, README, root contents, latest release. |
| `MetricsRepoPort` | Save/read metrics; trending queries. |
| `RepoIntelligencePort` | Append-only `RepoSnapshot` + `RepoHealthScore` writes (the historical data decay detection will eventually need). |
| `SessionStorePort` | Cross-run `seen`/`history` state. |
| `ReportWriterPort` | Write analysis/scout reports; read back the scout report. |
| `LlmPort` | `generateText(prompt)`. Deliberately thin — prompt construction and response parsing are business logic and stay in the caller. |

### Adapters (`src/adapters/`)

**Driven adapters** — the domain calls these:

| Adapter | Implements |
|---|---|
| `github/GithubAdapter` | `RepoApiPort` (Octokit, with rate-limit retries) |
| `database/PrismaAdapter` | `MetricsRepoPort` + `RepoIntelligencePort` |
| `session/FileSessionStore` | `SessionStorePort` (`.codex/session.json`) |
| `reports/MarkdownReportWriter` | `ReportWriterPort` (`reports/*.md`) |
| `llm/OpenAiAdapter` | `LlmPort` (Claude via REST if `CLAUDE_API_KEY` is set, else OpenAI) |

**Driving adapters** — these call the domain. They do *not* implement `RepoApiPort`/`MetricsRepoPort`; they're entry points:

- `src/cli/agent.ts` — conversational terminal agent (composition root + readline + rendering)
- `src/cli/index.ts` + `SearchCommand.ts` — direct CLI search command
- `src/server/express.ts` — HTTP API
- `src/server/mcp.ts` — MCP tools over stdio

`src/cli/stagedSearch.ts` composes the pipeline stages and renders CLI output; it is not itself domain logic.

---

## Staged Pipeline

Stage numbering follows `action-plan-v2.md`.

```
prompt
  │
  ├─ Stage 0  ParseIntent          → ParsedIntent + IntentClassification
  ├─ Stage 1  DiscoverRepos        → up to 200 merged candidates → preselected pool → enriched
  ├─ Stage 2  ApplyQualityGates    → survivors only
  ├─ Stage 3  ScoreAndRank         → prompt-fit filter
  ├─ Stage 4  ScoreAndRank         → composite score, sort, persist snapshot + health score
  └─ Stage 5  stagedSearch.ts      → trim to N, attach confidence + alternatives, render
```

Stage counts at each step are surfaced in CLI output (`raw → quality → fit → ranked → returned`), so a thin or over-filtered pool is visible rather than silent.

**Why staged:** it separates *retrieval breadth* (don't miss the right repo) from *shortlist precision* (explain why each one fits). Both use the same `ParsedIntent` — discovery uses it to build queries, ranking uses it to score fit.

### Scoring signals

- **Prompt fit** — name, description, README, topic matches; language match; artifact-type match
- **Health score (0–100)** — README quality, stars velocity, dependency freshness, maintenance quality, owner tier
- **Freshness** — push recency + release recency, weighted by domain speed
- **Decay** — `Healthy` / `Slowing` / `Fading` / `Abandoned`
- **Dependency health** — `Clean` / `Minor risk` / `Supply chain risk`
- **Owner tier** — `Elite` / `Strong` / `Promising` / `Weak`

All thresholds and weights live in `src/config/thresholds.ts`, not inline in logic.

---

## Persistence

`prisma/schema.prisma` defines the full intelligence data model. **Only some of it is wired:**

| Table | Status |
|---|---|
| `Repo`, `Metrics` | Active — read/written by `PrismaAdapter` |
| `RepoSnapshot`, `RepoHealthScore` | Active — written on every ranked search via `RepoIntelligencePort` |
| `OwnerProfile`, `DependencyMap`, `WatchTarget`, `WatchSubscription`, `NotificationEvent`, `SearchHistory`, `TrendSnapshot` | **Migrated but unwired.** No code reads or writes them yet. |

---

## Reports

- `reports/REPO_SCOUT_RESULTS.md` — shortlist table (repo, score, best-for, rationale, tradeoff, risk, metrics)
- `reports/REPO_ANALYSIS.md` — deep analysis: why selected, first impression, stack signals, structure overview, setup-quality signals, risks, README snapshot, metadata, metrics, language breakdown

`AnalyzeRepoDeep` reads back the scout report to correlate *why a repo was shortlisted* into its analysis, so the deep report explains selection rather than just dumping metrics.

---

## Testing

77 tests across 9 files (`npm test`, Vitest). Use cases are tested against mocked ports; adapters wrapping a real external SDK (`GithubAdapter`, `PrismaAdapter`, `OpenAiAdapter`) are verified live rather than mocked, on the principle that a mock diverging from the real API masks failures.

---

## Known Gaps

Honest list. Fuller detail in `KNOWN_ISSUES.md`.

- **No snapshot ingestion job.** `RepoSnapshot` rows accumulate only when someone runs a search, so history is sparse and usage-biased. `action-plan-v2.md` calls for a standing ingestion job; it doesn't exist.
- **Decay and dependency health are single-point heuristics.** They compute from current state, not historical deltas, despite `RepoSnapshot`/`DependencyMap` existing to support exactly that. `action-plan-v2.md` Phase 8 says not to build decay logic before snapshot cycles have run — it was built first. The labels are directionally useful but not yet backed by trend data.
- **`classifyIntent` / `inferArtifactType` still live in `src/cli/stagedSearch.ts`.** They're Stage 0 logic sitting in a CLI file; they belong with `ParseIntent`.
- **The discovery pipeline has no REST/MCP surface.** Only `AnalyzeRepo`/`GetTrending` are exposed there.
- **`AnalyzeRepo`/`GetTrending` don't write to `RepoIntelligencePort`,** so API/MCP usage contributes no snapshot history.
- **Spikes A/B/C** (README-scoring calibration, dependency data source, intent-classification accuracy) — `action-plan-v2.md` prerequisites — were never run as structured exercises.
- **`--trends` flag** (Phase 11) doesn't exist. `--explain` does.

---

## Roadmap

Ordered by dependency, following `action-plan-v2.md`'s unlock map.

**Next**
- Move `classifyIntent`/`inferArtifactType` into `ParseIntent`
- Snapshot ingestion job — unblocks everything trend-related
- Wire `AnalyzeRepo`/`GetTrending` to `RepoIntelligencePort`

**After real snapshot history exists (weeks, not days)**
- Genuine decay detection from deltas (Phase 8)
- Stars-velocity scoring off real trend data

**Requires a resolved data source**
- Dependency awareness / supply-chain risk (Phase 9, needs Spike B)

**Later**
- Owner profile persistence + weekly refresh (Phase 7)
- Search history, rerun-with-diff, trend radar, `--trends` (Phase 12)
- Watch targets and notifications (Phase 13)
- Compare mode between shortlisted repos
- Web UI over the same domain layer
