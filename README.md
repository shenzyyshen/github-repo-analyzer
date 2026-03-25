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
- **Category extraction**: infer whether a repo is a service, framework, SDK, plugin, CLI, server, workflow, library, or desktop app
- **Deep repo analysis**: select a repo from the shortlist and generate a richer markdown report in `reports/REPO_ANALYSIS.md`
- **Saved scout report**: each shortlist run writes `reports/REPO_SCOUT_RESULTS.md`
- **Session recall**: `seen`, `history`, and `.codex/session.json` preserve earlier shortlists and repo links across restarts
- **CLI fallback behavior**: if AI query translation is unavailable, the tool falls back to raw GitHub search instead of failing
- **REST API + MCP support**: same core capabilities can be exposed to programmatic clients and AI tooling
- **Hexagonal architecture**: domain logic stays isolated from GitHub, database, and transport adapters

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

## REST API
These endpoints are stable and intended for a future GUI:

- `GET /health`
- `POST /repos/:owner/:repo/analyze` (body: `{ "deep": false }`)
- `GET /repos/:owner/:repo`
- `GET /trending/:language?`

---

## MCP Tools
Exposes the same functionality to MCP-compatible AI clients:
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

---

## Architecture
This project uses **Hexagonal (Ports & Adapters)** architecture.

- `src/domain/` contains core entities and use cases
- `src/ports/` defines the interfaces the domain depends on
- `src/adapters/` implements GitHub and database access
- `src/cli/` contains the direct CLI commands, conversational agent, intent parser, retrieval logic, shortlist ranking, and session recall
- `src/server/` exposes the same core logic through API and MCP surfaces

This keeps the product logic separate from infrastructure details and makes retrieval, ranking, analysis, session recall, and transport layers easier to evolve independently.

See:
- `ARCHITECTURE.md`
- `docs/IMPLEMENTATION-AND-GUI.md`
- `docs/DECISIONS.md`

---

## Roadmap
**Short-term**
- Better README/topic-based category understanding
- Stronger prompt-specific ranking and rationale generation
- Startup session controls like `clear history` or resume prompts

**Medium-term**
- Search history and saved results
- GitHub OAuth and user-linked actions
- Compare mode for shortlisted repos

**Long-term**
- Web UI on top of the same API/domain layer
- Richer analytics and trend tracking
- Clone-based external repo quality analysis

---

## License
MIT (or add your preferred license)
