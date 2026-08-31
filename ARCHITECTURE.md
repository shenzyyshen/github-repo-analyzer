# Architecture — GitHub Repo Analyzer

This project uses **Hexagonal (Ports & Adapters)** architecture: business logic lives in `src/domain/`, depends only on port interfaces, and never imports a concrete adapter, HTTP framework, database client, or terminal library.

The product is a **terminal-first GitHub repo scout** that turns a natural-language request into a ranked, explained shortlist of repositories, plus a deep-analysis report for any repo you pick.

> **Status note.** This document describes the code as it actually is. Where something is planned-but-not-built, or built-but-not-trustworthy, it says so explicitly — see [Known Gaps](#known-gaps) and `KNOWN_ISSUES.md`. Two subsystems in this repo sit at different levels of maturity; [Two Subsystems](#two-subsystems) explains the split.

---

## Two Subsystems

This repo contains two related but distinct systems. Conflating them leads to overclaiming, so they're separated here.

**1. The staged discovery pipeline (CLI + MCP).** Natural-language search → multi-query retrieval → quality gates → prompt-fit scoring → composite ranking → shortlist. Lives in `SearchRepos` (domain). Reachable via `npm run repo` (conversational agent), `npm run cli -- search` (direct command), and the `search_repos` MCP tool. The same domain use case backs all three — the CLI adds chalk rendering, MCP adds JSON payload shaping, neither touches the pipeline. **No REST surface yet.**

**2. Single-repo lookup (CLI + REST + MCP).** `AnalyzeRepo` and `GetTrending` — fetch one repo's metrics, or list trending repos. Injected into all three transports in `src/index.ts`.

Both subsystems demonstrate the same property: a use case runs unmodified across delivery mechanisms, because each transport is a driving adapter that calls the domain rather than containing it.

---

## Layers

### Domain (`src/domain/`)

The business core. Zero imports from adapters, Express, Prisma, Octokit, OpenAI, or chalk.

**Use cases** (`src/domain/usecases/`):

| Use case | Stage | Responsibility |
|---|---|---|
| `ParseIntent` | 0 | Prompt string → `ParsedIntent` (language, license, activity, maturity signals, domain concepts, retrieval-query variants). Pure logic, no ports. |
| `SearchRepos` | 0–5 | Composes the whole pipeline: classifies intent, then runs discovery → gates → scoring, trims to N, attaches confidence and alternatives. The entry point every discovery surface calls. |
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
- `src/server/mcp.ts` — MCP tools over stdio (`search_repos`, `analyze_repo`, `get_trending`)

`src/cli/stagedSearch.ts` is CLI presentation only (`renderStagedSearch`), re-exporting the domain pipeline for existing call sites.

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
  ├─ Stage 5  SearchRepos          → trim to N, attach confidence + alternatives
  └─            stagedSearch.ts / mcp.ts   → render (CLI) or shape JSON (MCP)
```

Stage counts at each step are surfaced in CLI output (`raw → quality → fit → ranked → returned`), so a thin or over-filtered pool is visible rather than silent.

**Why staged:** it separates *retrieval breadth* (don't miss the right repo) from *shortlist precision* (explain why each one fits). Both use the same `ParsedIntent` — discovery uses it to build queries, ranking uses it to score fit.

### Scoring signals

- **Prompt fit** — name, description, README, topic matches; language match; artifact-type match
- **Health score (0–100)** — README quality, stars velocity, dependency freshness, maintenance quality, owner tier
- **Freshness** — push recency + release recency, weighted by domain speed
- **Decay** — `Healthy` / `Slowing` / `Fading` / `Abandoned`, evaluated live from the repo's current state (see the shelved ingestion job note below — this is a deliberate design choice, not an interim gap)
- **Dependency health** — `Clean` / `Minor risk` / `Supply chain risk`
- **Owner tier** — `Elite` / `Strong` / `Promising` / `Weak`, backed by a known-elite-owner list (Anthropic, OpenAI, Microsoft, etc.) plus stars/forks thresholds

All thresholds and weights live in `src/config/thresholds.ts`, not inline in logic.

### Composite ranking

The five signals above combine into one `finalScore` per candidate, weighted differently for fast-moving domains (LLM/agent/MCP-adjacent topics) versus slower-moving ones — prompt fit and health dominate either way, but a fast-moving query leans harder on freshness and lighter on maintenance history, since "actively evolving" is itself part of what's being asked for.

Two guarantees hold regardless of how a request is classified:

- **The weights always account for exactly the whole score** — nothing is silently over- or under-counted. When a request's freshness gets emphasized, the boost is funded from the health signal, verified by a test across every domain/emphasis combination.
- **Stars and owner reputation are protected signals.** Emphasizing freshness never discounts either — a request for something new and exciting still wants an adopted, credible result, not freshness traded off against them. A brand-new repo from a known, credible maintainer is treated on its own merits rather than penalized for not yet having built independent reputation.

When a result comes from a recognized elite-tier owner *and* was pushed within the last month, the reasoning explains that explicitly ("fresh release from an established maintainer") rather than leaving it implicit in the score — the aim is for a strong find to read as an obvious one, not just rank higher without explanation.

---

## Persistence

`prisma/schema.prisma` defines the full intelligence data model. **Only some of it is wired:**

| Table | Status |
|---|---|
| `Repo`, `Metrics` | Active — read/written by `PrismaAdapter` |
| `RepoSnapshot` | Active — written via `RepoIntelligencePort` on every ranked search (`ScoreAndRank`) and every single-repo lookup (`AnalyzeRepo`, so CLI/REST/MCP all contribute) |
| `RepoHealthScore` | Active — written only by `ScoreAndRank`; `AnalyzeRepo` doesn't fetch the README/root-contents/owner-tier inputs a health score needs |
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

- **No snapshot ingestion job — by decision, not by omission.** Considered and shelved 2026-08-05: this product is used for one-off, prompt-driven discovery, not repeated observation of a fixed portfolio, so a background poller has no stable set of repos to revisit. Decay and dependency health are evaluated live from current state instead — that's the intended design now, not a placeholder waiting on infrastructure. Detail in `KNOWN_ISSUES.md`.
- **`action-plan-v2.md` is stale against that decision** — it still presents the ingestion job as required groundwork (Risk 1, Phase 1, Phase 8, Phase 12). Not rewritten yet; a future reader would believe it's still planned.
- **The discovery pipeline has no REST surface.** It's reachable from CLI and MCP; Express still only exposes `AnalyzeRepo`/`GetTrending`.
- **Spike A (README-quality calibration)** is the one part of the shelved spike list that's now more relevant, not less — it's the direct validation of "does README comprehensiveness correctly outweigh raw stars," which the product leans on entirely now that there's no historical fallback. Spikes B and C are shelved/independent respectively — detail in `KNOWN_ISSUES.md`.
- **`--trends` flag** doesn't exist, and won't — it depended on `TrendSnapshot`, which depended on the shelved ingestion job.

---

## Roadmap

Ordered by dependency, following `action-plan-v2.md`'s unlock map where that map is still current.

**Next**
- Run Spike A (README-quality calibration) against real search results — the product's core judgment (README comprehensiveness vs. raw stars) now runs with no historical backstop, so validating it matters more than it did when the ingestion job was still on the table
- Decide whether/how to amend `action-plan-v2.md` itself so it stops presenting the shelved ingestion job as planned

**Shelved along with the ingestion job (2026-08-05)** — each of these needs snapshot history accumulating on a schedule, which this product deliberately doesn't build:
- Delta-based decay detection and stars-velocity scoring (Phase 8)
- Trend radar and rerun-with-diff (Phase 12)
- `--trends` flag (Phase 11)
- Watch targets and notifications (Phase 13)

**Independently open** — don't depend on the shelved job:
- Dependency awareness / supply-chain risk (Phase 9) — needs Spike B (data source) resolved first
- Owner profile persistence (Phase 7) — could refresh opportunistically on encounter, same pattern `RepoSnapshot` already uses, rather than needing a poller
- Plain search history (logging past searches) — distinct from trend radar above; doesn't need deltas, just a log
- Compare mode between shortlisted repos
- Web UI over the same domain layer
