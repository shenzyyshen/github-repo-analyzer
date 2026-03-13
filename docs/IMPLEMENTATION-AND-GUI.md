# What to Implement — and GUI Adaptability

This document defines **what you need to implement** (API, adapters, etc.) and how the same core stays **adaptable for a GUI** later. Right now the app is terminal/API-only; the design already supports adding a GUI without rewriting the core.

---

## 1. Why this design is GUI-adaptable

The **core** (domain entities + use cases + ports) does not know about HTTP, MCP, or any UI. It only knows:

- **Inbound:** “Someone called `AnalyzeRepo.execute(owner, repo, deep)` or `GetTrending.execute(language)`.”
- **Outbound:** “I need repo data” → `RepoApiPort`; “I need to save/load metrics” → `MetricsRepoPort`.

So:

- **Today:** A REST API and an MCP server are two different **driving adapters** that both call the same use cases.
- **Later:** A GUI is just another way to “drive” the app. You can:
  - **Option A (simplest):** Build a web or desktop GUI that talks to the **existing REST API**. No backend changes; the API is your “GUI backend.”
  - **Option B:** Add a new driving adapter (e.g. WebSocket server, or Electron process) that calls the same use cases and exposes a different surface (real-time, desktop-only, etc.).

The core, ports, and driven adapters (GitHub, DB) stay the same. You only add or reuse **driving** pieces (API, MCP, future GUI adapter).

---

## 2. What you need to implement — checklist

Everything the app needs is either **core** (already defined), **driving** (how the app is triggered), or **driven** (how the app talks to the outside world). Below is the full list and where it lives.

### 2.1 Core (domain — no “implementation” of infrastructure)

Defined once; no HTTP, DB, or GitHub here.

| Piece | Location | Status | Notes |
|-------|----------|--------|--------|
| Entities | `src/domain/entities/` | ✅ Defined | `Repo`, `Metrics`, `TrendingRepo` — data shapes only |
| Use cases | `src/domain/usecases/` | ✅ Defined | `AnalyzeRepo`, `GetTrending` — orchestration only |
| Ports (interfaces) | `src/ports/` | ✅ Defined | `RepoApiPort`, `MetricsRepoPort` — contracts only |

Nothing else to “implement” here; the rest of the system implements these contracts and calls these use cases.

---

### 2.2 Driving adapters (inbound — how the app is triggered)

These are the things that **receive** user or client input and **call** the use cases. Today: API and MCP. Future: GUI can reuse the API or add a new adapter.

| Piece | Location | Purpose | What you implement |
|-------|----------|--------|---------------------|
| **REST API** | `src/server/express.ts` | HTTP entrypoint: health, analyze, get metrics, trending | Express app: routes that call `analyzeRepo.execute()` and `getTrending.execute()`, error handling, request/response mapping |
| **MCP server** | `src/server/mcp.ts` | MCP tools for AI/IDE clients | MCP server that registers `analyze_repo` and `get_trending`, parses args, calls same use cases, returns results |
| **Wiring / bootstrap** | `src/index.ts` | Start app and connect adapters | Load env, create Prisma + adapters + use cases, start Express (e.g. port 3005), connect MCP stdio |

**Future — GUI:**  
- **If GUI talks to REST:** You only implement a **client** (web app, Electron, etc.) that calls `GET/POST` to your existing API. No new backend “thing” in this repo.  
- **If GUI needs a different backend surface:** Add another driving adapter (e.g. `src/server/websocket.ts` or an Electron main process) that instantiates the same use cases and exposes a different protocol. The checklist then gets one more row: “WebSocket server” or “Electron IPC” etc.

---

### 2.3 Driven adapters (outbound — how the app talks to the world)

These **implement the ports** the use cases depend on. The core never imports these; they are injected at startup.

| Piece | Location | Implements | What you implement |
|-------|----------|------------|---------------------|
| **GitHub API** | `src/adapters/github/GithubAdapter.ts` | `RepoApiPort` | `getRepo`, `getLanguages`, `getIssues` using Octokit (REST). Constructor takes `GITHUB_TOKEN`. |
| **Database** | `src/adapters/database/PrismaAdapter.ts` | `MetricsRepoPort` | `saveMetrics` (upsert), `getMetrics`, `getTrending` using Prisma. Constructor takes `PrismaClient`. |
| **Persistence schema** | `prisma/schema.prisma` | — | `metrics` table (and migrations). Required for `PrismaAdapter`. |

No other driven adapters are required for the current scope. If later you add e.g. caching or search, you’d add a new port and a new adapter (and keep the core unchanged).

---

### 2.4 Summary table — “What do I need to implement?”

| Layer | Component | File(s) | Implements / Uses |
|-------|-----------|---------|--------------------|
| **Driving** | REST API | `server/express.ts` | Express routes → use cases |
| **Driving** | MCP server | `server/mcp.ts` | MCP tools → use cases |
| **Driving** | Bootstrap | `index.ts` | Env, adapters, use cases, start servers |
| **Driven** | GitHub | `adapters/github/GithubAdapter.ts` | `RepoApiPort` (Octokit) |
| **Driven** | Database | `adapters/database/PrismaAdapter.ts` | `MetricsRepoPort` (Prisma) |
| **Driven** | Schema | `prisma/schema.prisma` | DB model for metrics |

The **API** is the REST app in `server/express.ts`: that’s what you implement for HTTP. For a GUI that talks over the network, that same API is what the GUI calls unless you add another driving adapter.

---

## 3. API surface (for terminal now, GUI later)

So that any client (curl, script, or future GUI) knows what to call:

- **GET  /health**  
  Liveness check.

- **POST /repos/:owner/:repo/analyze**  
  Body: `{ "deep": true }` (optional).  
  Runs analyze; returns `Metrics` JSON.

- **GET  /repos/:owner/:repo**  
  Returns stored `Metrics` or 404.

- **GET  /trending/:language?**  
  Optional `language` filter. Returns `TrendingRepo[]`.

A future GUI can use exactly these endpoints (and optionally add WebSocket or another adapter if you need real-time updates or a different UX).

---

## 4. What a GUI would implement (when you add one)

- **Backend:** Nothing new if the GUI uses the existing REST API. Optionally: a new driving adapter (e.g. WebSocket, or a small BFF) if you need different semantics or real-time.
- **Frontend:** A separate app (React, Vue, Electron, etc.) that:
  - Calls the REST API above, or
  - Connects to a new adapter you add (e.g. WebSocket) that still calls the same use cases under the hood.

The core, ports, and GitHub/DB adapters stay as they are; only the “way in” (driving side) can grow (API + MCP + future GUI adapter).
