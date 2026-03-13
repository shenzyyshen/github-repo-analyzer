# Architecture — GitHub Repo Analyzer

This project uses **Hexagonal (Ports & Adapters)** architecture so the core stays independent of HTTP, databases, and GitHub, and can be used from a **terminal/API today** and a **GUI later** without rewriting business logic.

---

## Quick links

| Document | Purpose |
|----------|--------|
| **[docs/Architecture.md](docs/Architecture.md)** | Full architecture: layers, diagrams, port/entity definitions, invariants |
| **[docs/IMPLEMENTATION-AND-GUI.md](docs/IMPLEMENTATION-AND-GUI.md)** | **What to implement** (API, MCP, adapters) and how the design is **GUI-adaptable** |

---

## Design in one paragraph

**Core (domain):** Entities (`Repo`, `Metrics`, `TrendingRepo`) and use cases (`AnalyzeRepo`, `GetTrending`) live in `src/domain/`. They depend only on **port interfaces** in `src/ports/` (e.g. `RepoApiPort`, `MetricsRepoPort`), not on Express, Prisma, or Octokit.

**Driving (inbound):** REST API (`server/express.ts`) and MCP server (`server/mcp.ts`) receive requests and call the use cases. A future GUI can use the same API or add a new driving adapter.

**Driven (outbound):** `GithubAdapter` implements `RepoApiPort`; `PrismaAdapter` implements `MetricsRepoPort`. All wiring (creating adapters and use cases, starting servers) happens in `src/index.ts`.

See **docs/IMPLEMENTATION-AND-GUI.md** for the exact list of what you need to implement (API, MCP, adapters) and how a GUI fits in.
