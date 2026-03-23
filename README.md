# AI-Assisted GitHub Repository Discovery

## Concept
A tool that helps users find interesting or useful GitHub repositories using **natural language** instead of manual GitHub search filters.

**Core idea:**  
You type what you want. The system uses AI to translate that into a GitHub search query, fetches results, analyzes them, and returns the best options.

Example prompt:
> “I want a script that sets up a new Linux environment automatically.”

---

## Current Capabilities
- **AI-assisted search**: free-text prompt → AI → GitHub search query  
- **CLI workflow**: search and analyze repos directly in the terminal  
- **Analysis + persistence**: each repo analyzed is stored in Postgres  
- **REST API**: for programmatic access and future GUI integration  
- **MCP server**: exposes tools for AI clients  
- **Hexagonal architecture**: domain core is isolated from adapters

---

## Flow (High Level)
1. User submits a natural-language query.  
2. AI translates it into a GitHub search query.  
3. GitHub API is queried for matching repos.  
4. Top results are analyzed and returned.

---

## CLI Usage (Primary Interface)
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

### Conversational Agent
```bash
npm run agent
```

This starts an interactive terminal session that:
- accepts a plain-English repo discovery request
- searches and analyzes GitHub repos
- responds conversationally
- overwrites `reports/REPO_SCOUT_RESULTS.md` on each run with a timestamped shortlist report that includes repo descriptions and GitHub links

### API server
```bash
npm run dev
```

---

## Architecture
This project uses **Hexagonal (Ports & Adapters)** architecture. Domain logic is in `src/domain/`, ports in `src/ports/`, and adapters in `src/adapters/`.  
See:
- `ARCHITECTURE.md`
- `docs/IMPLEMENTATION-AND-GUI.md`
- `docs/DECISIONS.md`

---

## Roadmap (Planned)
**Search + discovery**
- Smart ranking (composite score)
- Search history + saved results
- Interactive CLI selection

**GitHub integration**
- OAuth device flow
- Ability to star repos from the CLI

**UI**
- CLI-first (current)
- GUI later (React or Next.js)

---

## License
MIT (or add your preferred license)
