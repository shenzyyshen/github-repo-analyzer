# AI-Assisted GitHub Repository Discovery

## Concept
A tool that helps users find interesting or useful GitHub repositories using **natural language** instead of manual GitHub search filters.

**Core idea:**  
You type what you want. The system uses AI to translate that into a GitHub search query, fetches results, analyzes them, and returns the best options.

Example prompt:
> “I want a script that sets up a new Linux environment automatically.”

---

## Core Features
- **Natural-language repository discovery**: describe what you want in plain English instead of writing GitHub qualifiers manually
- **Conversational terminal interface**: run `npm run repo` and interactively search, refine, shortlist, and analyze repos
- **AI-assisted intent parsing**: extract signals like language, activity, license, maturity, and product type from user prompts
- **Multi-query retrieval**: generate several GitHub search formulations, merge results, and rank from a broader candidate pool
- **Concept-aware search broadening**: retry with broader domain terms when the first GitHub query is too narrow
- **Shortlist ranking with rationale**: rank repos by prompt fit, adoption, maturity, maintenance, setup signals, release signals, and quality-floor filters
- **Decision-ready shortlist output**: each candidate includes best use case, rationale, tradeoff, caution, stars, forks, contributors, age, language, and GitHub link
- **Risk-aware repo curation**: evaluate issue pressure, maintenance risk, release risk, adoption risk, and setup risk
- **Artifact-type inference**: classify a repo as a library, framework, CLI, tips-content, dataset, boilerplate, or general tool, and score how well that matches what you asked for
- **Deep repo analysis**: select a repo from the shortlist and generate a richer markdown report in `reports/REPO_ANALYSIS.md`
- **Saved scout report**: each shortlist run writes `reports/REPO_SCOUT_RESULTS.md`
- **Session recall**: `seen`, `history`, and `.codex/session.json` preserve earlier shortlists and repo links across restarts
- **Staged pipeline with visible funnel**: every search reports `raw → quality → fit → ranked → returned` counts, so an over-filtered or thin pool is visible rather than silent
- **CLI fallback behavior**: if AI query translation is unavailable, the tool falls back to raw GitHub search instead of failing
- **REST API + MCP**: single-repo analysis and trending are exposed over HTTP and MCP (see [Scope](#scope) — the discovery pipeline above is CLI-only)
- **Hexagonal architecture**: domain logic depends only on port interfaces — six ports with swappable adapters for GitHub, PostgreSQL, LLM providers, session state, and report output

---

## Interactive Workflow
1. User starts the conversational scout with `npm run repo`.
2. User enters a natural-language prompt such as:
   - `I want an open source self-hosted tool for monitoring APIs and websites`
3. The agent parses intent and extracts useful filters such as:
   - language
   - license
   - activity
   - product category
   - maturity signals
4. The system generates multiple GitHub search formulations, merges results, broadens the search if needed, and analyzes a larger candidate pool.
5. The user sees a ranked shortlist with:
   - best use case
   - why it ranked there
   - tradeoffs and cautions
   - repo metrics and GitHub link
6. The user can then:
   - pick a repo for deeper analysis
   - refine the shortlist
   - `re run` to get a different set of repos
   - `seen` / `history` to recall earlier results
   - go back
   - open a repo in the browser

---

## CLI Usage
```bash
npm run cli -- search "<query>" [options]
```

Options:
- `--language <lang>` filter by language
- `--min-stars <n>` minimum stars
- `--since <YYYY-MM-DD>` pushed after date
- `--sort <stars|updated|forks>` sort order
- `--random` pick random results from top 100
- `--json` output raw search results (skip analyze)
- `--top <n>` results to analyze (default 5, max 10)

Examples:
```bash
npm run cli -- search "linux environment setup" --language shell --min-stars 500
npm run cli -- search "websocket" --random
npm run cli -- search "llm inference" --sort updated --top 3
```

## Conversational Agent
Primary interactive entry point:

```bash
npm run repo
```

You can then type prompts like:

```text
I want an open source self-hosted tool for monitoring APIs and websites
```

or:

```text
mcp agents for ai and coding tasks
```

Useful in-session commands:
- `re run` — set the current shortlist aside and fetch a different set
- `seen` — show repos already surfaced in this session
- `history` — show previous shortlists by prompt
- `back` — return to the current shortlist
- `quit` — exit cleanly

---

## Scope

This repo contains two related systems at different levels of maturity. Worth knowing which is which:

| | Discovery pipeline | Single-repo lookup |
|---|---|---|
| **What** | Natural-language search → retrieval → gates → scoring → ranked shortlist | Analyze one repo's metrics; list trending repos |
| **Surfaces** | CLI only (`npm run repo`, `npm run cli -- search`) | CLI + REST + MCP |
| **Use cases** | `ParseIntent`, `DiscoverRepos`, `ApplyQualityGates`, `ScoreAndRank`, `AnalyzeRepoDeep` | `AnalyzeRepo`, `GetTrending` |

The single-repo use cases run unmodified across all three transports via constructor injection in `src/index.ts`. The discovery pipeline has no HTTP or MCP surface yet.

---

## REST API
Single-repo analysis and trending over HTTP. Stable, intended for a future GUI:

- `GET /health`
- `POST /repos/:owner/:repo/analyze` (body: `{ "deep": false }`)
- `GET /repos/:owner/:repo`
- `GET /trending/:language?`

---

## MCP Tools
The same two use cases exposed to MCP-compatible AI clients over stdio:
- `analyze_repo(owner, repo, deep?)`
- `get_trending(language?)`

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
Create `.env`:
```env
GITHUB_TOKEN=ghp_...
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://user:password@localhost:5432/repo_metrics
PORT=3005

# Optional
OPENAI_MODEL=gpt-4o-mini
# If set, the conversational agent prefers Claude over OpenAI
CLAUDE_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-20250514
```

### 3. Start Postgres
```bash
docker-compose up -d
```

### 4. Run migrations
```bash
npx prisma migrate dev --name init
```

---

## Run

### CLI
```bash
npm run cli -- search "react state management" --language ts --min-stars 1000
```

### API server
```bash
npm run dev
```

### Tests
```bash
npm test
```

---

## Architecture
This project uses **Hexagonal (Ports & Adapters)** architecture. The domain depends only on port interfaces — never on a concrete adapter, HTTP framework, database client, or terminal library.

- `src/domain/usecases/` — the pipeline stages and analysis use cases (`ParseIntent`, `DiscoverRepos`, `ApplyQualityGates`, `ScoreAndRank`, `AnalyzeRepoDeep`, `ManageSession`, `AnalyzeRepo`, `GetTrending`)
- `src/domain/entities/`, `src/domain/shared/` — data shapes and cross-stage pure helpers
- `src/ports/` — six interfaces: `RepoApiPort`, `MetricsRepoPort`, `RepoIntelligencePort`, `SessionStorePort`, `ReportWriterPort`, `LlmPort`
- `src/adapters/` — one implementation per port: Octokit, Prisma, file-based session store, markdown report writer, OpenAI/Claude
- `src/cli/`, `src/server/` — driving adapters (composition roots, prompts, rendering, HTTP/MCP transport)

`src/config/thresholds.ts` holds every tunable scoring constant, so ranking behavior can be adjusted without touching logic.

See `ARCHITECTURE.md` for the full picture, including an honest list of known gaps.

---

## Roadmap

See `ARCHITECTURE.md` for the dependency-ordered version and `KNOWN_ISSUES.md` for tracked gaps.

**Next**
- Move `classifyIntent`/`inferArtifactType` from `src/cli/stagedSearch.ts` into `ParseIntent`
- Snapshot ingestion job — currently `RepoSnapshot` only grows when someone runs a search, which blocks trustworthy trend detection
- Wire `AnalyzeRepo`/`GetTrending` to `RepoIntelligencePort` so API/MCP usage also contributes history

**Once real snapshot history exists**
- Decay detection from actual deltas rather than single-point heuristics
- Stars-velocity scoring off real trend data

**Later**
- Dependency/supply-chain risk (needs a confirmed data source)
- Owner profile persistence, search history, trend radar, `--trends`
- Watch targets and notifications
- Compare mode for shortlisted repos
- Web UI over the same domain layer

---

## License
MIT (or add your preferred license)
