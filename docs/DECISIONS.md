# Architecture Decision Log

Single source of truth for every significant technical choice made or planned in this project.

### DEC-001 — TypeScript as primary language
**Status:** Decided
**Date:** 2026-03-16
**Context:** type safety critical for domain modeling and port contracts.
**Decision:** TypeScript 5+ strict mode throughout.
**Alternatives considered:** plain JS, Go.
**Consequences:** strict interfaces enforce hexagonal boundaries at compile time; build step required for production.

### DEC-002 — Hexagonal (Ports & Adapters) architecture
**Status:** Decided
**Date:** 2026-03-16
**Context:** need to swap GitHub API, DB, and transport layers independently.
**Decision:** domain/ports/adapters split, zero cross-layer imports enforced by convention and linting.
**Alternatives considered:** layered MVC, flat service pattern.
**Consequences:** longer initial scaffold; use cases are fully testable with mock ports.

### DEC-003 — Prisma as ORM
**Status:** Decided
**Date:** 2026-03-16
**Context:** needed type-safe DB access with migration tooling.
**Decision:** Prisma + PostgreSQL 16 via Docker.
**Alternatives considered:** Drizzle, Knex, raw pg.
**Consequences:** generated client is not injectable as a plain interface; PrismaAdapter wraps it to satisfy MetricsRepoPort.

### DEC-004 — Octokit as GitHub client
**Status:** Decided
**Date:** 2026-03-16
**Context:** official GitHub REST client with built-in auth and pagination.
**Decision:** @octokit/rest, injected via constructor into GithubAdapter.
**Alternatives considered:** raw fetch, axios.
**Consequences:** Octokit types must be mapped to domain entities at the adapter boundary — raw types never enter domain/.

### DEC-005 — Express over Fastify
**Status:** Decided
**Date:** 2026-03-16
**Context:** HTTP layer for REST API.
**Decision:** Express on port 3005.
**Alternatives considered:** Fastify (faster, stricter schema), Hono.
**Consequences:** slightly more boilerplate for validation; easier to find middleware ecosystem.

### DEC-006 — MCP via stdio transport
**Status:** Decided
**Date:** 2026-03-16
**Context:** expose analyzer as AI tool for Claude Desktop.
**Decision:** @modelcontextprotocol/typescript-sdk, stdio transport.
**Alternatives considered:** HTTP transport.
**Consequences:** server runs as a subprocess, not a daemon; must be configured in claude_desktop_config.json.

### DEC-007 — CLI via commander + dotenv
**Status:** Decided
**Date:** 2026-03-16
**Context:** local developer workflow for search + analyze.
**Decision:** commander for arg parsing, dotenv/config auto-loaded at CLI entry.
**Alternatives considered:** yargs, manual process.argv.
**Consequences:** .env is auto-read so no manual source step; GITHUB_TOKEN must be present in .env.

### DEC-008 — GUI: deferred, CLI-first
**Status:** Proposed
**Date:** 2026-03-16
**Context:** no UI layer exists yet.
**Decision:** CLI-first until core features are stable. When GUI is added, direction is TBD (React dashboard or Next.js most likely).
**Alternatives considered:** build GUI in parallel, build GUI first.
**Consequences:** all HTTP endpoints must remain clean REST contracts so a future frontend can consume them without changes.

### DEC-009 — GitHub OAuth: not yet implemented
**Status:** Proposed
**Date:** 2026-03-16
**Context:** current auth is a personal access token in .env.
**Decision:** defer OAuth until multi-user or GUI use case requires it.
**Alternatives considered:** OAuth app, GitHub App (more powerful, required for org-level).
**Consequences:** single-user only; token scopes must cover public_repo read.

### DEC-010 — Metrics storage: upsert (last-write-wins)
**Status:** Decided
**Date:** 2026-03-16
**Context:** simplest caching strategy for MVP.
**Decision:** upsert on (repoOwner, repoName) — one row per repo, always current.
**Alternatives considered:** append-only time series.
**Consequences:** 24h growth is computed from the delta between current and previous snapshot; no historical graph possible without schema change (see DEC-011).

### DEC-011 — Metrics history: append-only table (planned)
**Status:** Proposed
**Date:** 2026-03-16
**Context:** trending and growth charts need historical data.
**Decision:** add a metrics_history table (append-only) alongside the current upsert table. Each analyze call writes to both.
**Alternatives considered:** keep only the current snapshot, export data to external analytics store.
**Consequences:** schema migration required; query layer needs a new port method getMetricsHistory(owner, repo).

### DEC-012 — Search ranking: stars-first with optional random mode
**Status:** Decided
**Date:** 2026-03-16
**Context:** CLI search needed a default sort that surfaces quality repos.
**Decision:** default sort = stars desc; --random flag shuffles first 100 results for discovery.
**Alternatives considered:** score by composite (stars + recency + issues ratio).
**Consequences:** random mode is genuinely fun but non-deterministic; composite scoring is a future improvement (see features/cli-search-analyze.md).

### DEC-013 — Rate limiting: exponential backoff in GithubAdapter
**Status:** Decided
**Date:** 2026-03-16
**Context:** GitHub returns 403/429 on rate limit exhaustion.
**Decision:** private withRetry helper in GithubAdapter, 3 retries, 2^n × 1000ms backoff, respects x-ratelimit-reset header.
**Alternatives considered:** token bucket at call site, global rate limiter singleton.
**Consequences:** retry logic is co-located with the adapter; all GitHub calls benefit automatically.

### DEC-014 — AI query translation (MCP tools)
**Status:** Proposed
**Date:** 2026-03-16
**Context:** MCP tools currently accept structured params (owner, repo).
**Decision:** add a natural language query tool that translates a free-text prompt into a GitHub search query before calling searchRepos. Implementation: prompt template passed to Claude API inside the MCP tool handler.
**Alternatives considered:** require structured params only, use OpenAI API for translation.
**Consequences:** requires ANTHROPIC_API_KEY; adds latency; output quality depends on prompt design (see features/mcp-server-ai-tools.md).
