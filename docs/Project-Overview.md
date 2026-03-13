# general.md — GitHub Repo Analyzer: Project Overview

---

## What This Is

A **production-grade GitHub repository analytics engine** built in TypeScript/Node.js that:

- Fetches live data from the GitHub REST API (stars, languages, issues, contributors, last commit)
- Computes 24-hour star growth by diffing against a cached previous snapshot
- Persists metrics to PostgreSQL via Prisma for fast retrieval and trending queries
- Exposes everything via both an **HTTP REST API** and an **MCP (Model Context Protocol) server** for AI assistant integration

The entire system is organized around **Hexagonal Architecture** (Ports & Adapters): business logic sits at the center and is completely decoupled from GitHub, Postgres, Express, or any other delivery mechanism.

---

## Target Use Case

> "I want to understand how a GitHub repo is growing — and I want that as both an API and an AI tool."

- **Developer / DevRel use**: POST to `/repos/facebook/react/analyze` and get structured metrics back
- **AI assistant use**: Wire the MCP server to Claude Desktop and ask "analyze the vercel/next.js repo"
- **Trend tracking**: `GET /trending/TypeScript` returns top repos ranked by 24h star growth

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Node 20 LTS + TypeScript 5 | Stable, `satisfies`, full ESM support |
| HTTP server | Express (port 3005) | Lightweight, widely understood |
| GitHub client | Octokit (`@octokit/rest`) | Official, handles rate limits and pagination |
| ORM | Prisma + PostgreSQL 16 | Type-safe queries, easy migrations |
| MCP | `@modelcontextprotocol/typescript-sdk` | Exposes tools to AI assistants |
| Dev tooling | tsx (hot reload), ts-node | Fast DX without build step during development |
| Containerization | Docker Compose | One command to get Postgres running |

---

## Project Structure Explained

```
github-repo-analyzer/
│
├── src/
│   ├── domain/                 ← THE CORE. No external imports.
│   │   ├── entities/           ← Repo, Metrics, TrendingRepo (pure TS interfaces)
│   │   └── usecases/           ← AnalyzeRepo, GetTrending (orchestrate via ports)
│   │
│   ├── ports/                  ← CONTRACTS. Interfaces only, zero implementation.
│   │   ├── RepoApiPort.ts      ← what we need from any GitHub-like source
│   │   └── MetricsRepoPort.ts  ← what we need from any metrics store
│   │
│   ├── adapters/               ← IMPLEMENTATIONS. Wired in from index.ts.
│   │   ├── github/
│   │   │   └── GithubAdapter.ts    ← Octokit implements RepoApiPort
│   │   └── database/
│   │       └── PrismaAdapter.ts    ← Prisma implements MetricsRepoPort
│   │
│   ├── server/                 ← DELIVERY MECHANISMS. Also adapters, inward-facing.
│   │   ├── express.ts          ← HTTP endpoints call use cases
│   │   └── mcp.ts              ← MCP tools call use cases
│   │
│   └── index.ts                ← Wiring: instantiate adapters → inject into use cases
│                                          → inject use cases into servers → start
│
├── prisma/
│   └── schema.prisma           ← `repos` + `metrics` tables
│
├── docker-compose.yml          ← PostgreSQL service
├── .env.example                ← GITHUB_TOKEN, DATABASE_URL, PORT
│
├── README.md                   ← Quick start
├── ARCHITECTURE.md             ← Full hexagonal diagram + layer docs
└── docs/INSTALL.md             ← Step-by-step setup guide
```

---

## How It Boots

```
index.ts
  │
  ├── 1. Load env vars (.env / process.env)
  ├── 2. Instantiate PrismaClient
  ├── 3. new GithubAdapter(GITHUB_TOKEN)        ← satisfies RepoApiPort
  ├── 4. new PrismaAdapter(prismaClient)         ← satisfies MetricsRepoPort
  ├── 5. new AnalyzeRepo(githubAdapter, prismaAdapter)
  ├── 6. new GetTrending(prismaAdapter)
  ├── 7. createExpressApp(...)  → listen on PORT
  └── 8. createMcpServer(...)   → connect stdio transport
```

Everything is assembled in one place. Swap `GithubAdapter` for `MockGithubAdapter` in tests — no other code changes.

---

## Core Metrics Output

Every `analyzeRepo` call returns:

```typescript
{
  stars: 220_500,
  starGrowth24h: "+312 (0.14%)",    // diff from last snapshot
  languages: {
    TypeScript: 2_340_000,
    JavaScript: 180_000,
    CSS: 45_000
  },
  openIssues: 748,
  contributors: 1_623,
  lastCommit: "2024-01-15T14:23:00Z",
  analyzedAt: "2024-01-16T09:00:00Z"
}
```

`starGrowth24h` is computed as:
```
current.stars - previous.stars  (if previous snapshot exists within 24h window)
otherwise: "+N/A (first analysis)"
```

---

## HTTP API Reference

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/health` | — | `{ status, ts }` |
| `POST` | `/repos/:owner/:repo/analyze` | `{ deep?: boolean }` | `Metrics` |
| `GET` | `/repos/:owner/:repo` | — | `Metrics \| 404` |
| `GET` | `/trending/:language?` | — | `TrendingRepo[]` |

`deep: true` fetches detailed issue data (slower, uses extra API calls).

---

## MCP Tools Reference

| Tool | Input Schema | Description |
|------|-------------|-------------|
| `analyze_repo` | `owner: string, repo: string, deep?: boolean` | Full analysis + cache |
| `get_trending` | `language?: string` | Top repos by 24h star growth |

**MCP integration with Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "github-analyzer": {
      "command": "node",
      "args": ["dist/index.js", "--mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "DATABASE_URL": "postgresql://..."
      }
    }
  }
}
```

---

## Database Design Decisions

- **Upsert strategy**: `metrics` table has a `@@unique([repoOwner, repoName])` — each analyze call overwrites the previous snapshot. This keeps the table lean and queryable.
- **Growth calculation**: Happens in the use case (domain logic), not in SQL. Previous snapshot is loaded, delta computed in TypeScript, result persisted.
- **Trending query**: Selects all rows with `analyzedAt > now - 24h`, orders by parsed `starGrowth24h`, optionally filters by `primaryLanguage`. Index on `analyzedAt` keeps this fast.

---

## Development Workflow

```bash
# 1. Start Postgres
docker-compose up -d

# 2. Set up .env
cp .env.example .env
# → fill in GITHUB_TOKEN and DATABASE_URL

# 3. Run migrations
npx prisma migrate dev --name init

# 4. Start dev server (hot reload)
npm run dev

# 5. Test an analysis
curl -X POST http://localhost:3005/repos/facebook/react/analyze \
  -H "Content-Type: application/json" \
  -d '{"deep": false}'
```

---

## Extension Points

Because of the hexagonal structure, the following extensions require **zero changes to domain code**:

| Extension | What to add |
|-----------|-------------|
| GitLab support | New `GitLabAdapter` implementing `RepoApiPort` |
| Redis caching layer | New `RedisMetricsAdapter` implementing `MetricsRepoPort` |
| GraphQL API | New server adapter alongside Express |
| CLI tool | New driving adapter calling the same use cases |
| Webhook triggers | New inbound adapter → calls `AnalyzeRepo` on push events |
| Rate limiting | Middleware in Express adapter only |
| Auth | Middleware in Express adapter only |

---

## MVP Scope vs Future Work

### MVP (this implementation)
- Single-table metrics store with upsert
- 24h star growth via snapshot diff
- REST + MCP delivery
- Dockerized Postgres
- No auth, no rate limiting

### Future
- Historical metrics time series (append-only metrics table)
- Webhook-triggered analysis
- Redis cache layer (sub-50ms reads)
- Fine-grained access control
- Multi-org dashboard aggregation

---

## Key Architectural Invariants

1. **Domain imports nothing from outside itself.** No Octokit, no Prisma, no Express in `src/domain/`.
2. **Ports are interfaces only.** No logic in `src/ports/`.
3. **Adapters never import each other.** `GithubAdapter` and `PrismaAdapter` are independent.
4. **Wiring happens exactly once**, in `src/index.ts`.
5. **Use cases are testable with zero infrastructure** — inject mock ports, done.

---

*Document version: 1.0 — corresponds to MVP implementation scope*
