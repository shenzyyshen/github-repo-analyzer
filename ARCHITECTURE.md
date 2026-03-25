# Architecture — GitHub Repo Analyzer

This project uses **Hexagonal (Ports & Adapters)** architecture to keep the core repo-discovery logic independent from GitHub, PostgreSQL, HTTP, MCP, and terminal UI concerns.

The current product is a **terminal-first GitHub repo scout** with:
- conversational repo discovery
- multi-query GitHub retrieval
- shortlist curation with rationale and risk analysis
- deep repo analysis with README/root-content inspection
- API and MCP surfaces over the same core logic

---

## System Overview

At a high level, the system works like this:

1. A user enters a natural-language request in the conversational agent or CLI.
2. The system parses intent into structured search signals.
3. It generates multiple GitHub query formulations.
4. It searches GitHub, merges and deduplicates candidates.
5. It preselects and analyzes a larger candidate pool.
6. It ranks candidates into a final shortlist using prompt fit, maturity, adoption, setup signals, release signals, category extraction, and risk analysis.
7. The user can inspect the shortlist, rerun, refine, review seen/history, or choose one repo for deeper analysis.

---

## Architectural Layers

### Domain
Location:
- `src/domain/`

This is the business core.

Key responsibilities:
- define entities such as `Repo`, `Metrics`, `SearchResult`, and `TrendingRepo`
- implement use cases such as:
  - `AnalyzeRepo`
  - `GetTrending`

The domain depends only on port interfaces, not on concrete adapters.

### Ports
Location:
- `src/ports/`

Ports define what the domain needs from the outside world.

Key ports:
- `RepoApiPort`
- `MetricsRepoPort`

Current GitHub-facing capabilities exposed through `RepoApiPort` include:
- repo metadata
- languages
- issues
- contributors
- search
- README retrieval
- root contents retrieval
- latest release retrieval

### Adapters
Location:
- `src/adapters/`

Adapters implement the ports.

Current adapters:
- `src/adapters/github/GithubAdapter.ts`
- `src/adapters/database/PrismaAdapter.ts`

Responsibilities:
- GitHub adapter translates GitHub REST API responses into domain-friendly shapes
- Prisma adapter persists analysis output and serves trending/metrics data

### Delivery Surfaces
Locations:
- `src/cli/`
- `src/server/`

These are the entry points that drive the same core logic.

Current delivery surfaces:
- direct CLI commands
- conversational terminal agent
- Express API
- MCP server

---

## Runtime Components

### Conversational Agent
Primary file:
- `src/cli/agent.ts`

This is the main product runtime.

It handles:
- natural-language user input
- search planning
- multi-query retrieval
- candidate preselection
- shortlist ranking
- rationale generation
- risk generation
- session recall (`seen`, `history`, `re run`)
- deep-analysis handoff
- markdown report generation

### Intent Parser
Primary file:
- `src/cli/intent.ts`

This layer translates raw natural language into structured intent.

Responsibilities:
- detect language
- detect license
- detect activity signals
- detect maturity signals
- detect domain concepts
- normalize purpose terms
- generate broader search formulations
- generate multi-query retrieval variants
- decide when the agent should clarify rather than search

This layer is critical because GitHub search itself is not semantic enough to map vague user language directly to strong repo results.

### GitHub Adapter
Primary file:
- `src/adapters/github/GithubAdapter.ts`

Responsibilities:
- search GitHub repos
- retrieve repo metadata
- retrieve contributors
- retrieve languages
- retrieve issues
- retrieve README content
- retrieve root contents
- retrieve latest release
- handle GitHub rate-limit retries

This adapter is the external retrieval and inspection layer.

### Database Adapter
Primary file:
- `src/adapters/database/PrismaAdapter.ts`

Responsibilities:
- store repo metrics
- read saved repo metrics
- support trending views

The current persistence model is lightweight and centered on analysis snapshots.

### API Server
Primary file:
- `src/server/express.ts`

Responsibilities:
- expose repo analysis through HTTP
- expose trending through HTTP
- expose stored metrics through HTTP

### MCP Server
Primary file:
- `src/server/mcp.ts`

Responsibilities:
- expose repo analysis and trending through MCP tools

---

## Retrieval Pipeline

The current retrieval pipeline is one of the most important parts of the system.

### Old failure mode
Earlier versions effectively depended too heavily on one GitHub query and ranked too late.

That meant the system could end up choosing from:
- the first GitHub results for one phrasing
rather than:
- the strongest candidates across multiple useful phrasings

### Current retrieval pipeline

1. Parse user intent
2. Generate multiple retrieval queries
3. Search GitHub for each query
4. Merge all retrieved candidates
5. Deduplicate by repo full name
6. Pre-score the merged pool
7. Select a larger candidate set
8. Analyze that set
9. Rank into a final shortlist

This is a major architectural improvement because it separates:
- **retrieval breadth**
from
- **shortlist precision**

---

## Shortlist Ranking Pipeline

The shortlist is not just GitHub search output.

It is a second-stage ranking system that tries to answer:
- why this repo is here
- why it is above the others
- what kind of team it is best for
- what the tradeoff is
- what risk the user is taking

### Current shortlist signals

The shortlist uses:
- prompt-fit signals
- README reinforcement
- topic matches
- stars
- forks
- contributors
- repo age
- maintenance recency
- setup-quality signals from root files
- release signals
- category extraction
- context-aware risk analysis

### Diversity constraints

The final shortlist also tries not to cluster too heavily around:
- one fit type
- one repeated tradeoff
- one repeated risk pattern

This is intended to give the user five meaningfully different choices rather than five near-identical repos with the same weakness.

---

## Category Extraction

The system now attempts to infer the repo’s product shape from:
- README
- description
- topics
- root files
- repo naming hints

Current categories include:
- `service`
- `framework`
- `sdk`
- `plugin`
- `desktop-app`
- `cli`
- `server`
- `workflow`
- `library`
- `general`

This feeds into:
- `Best for`
- `Tradeoff`
- rationale generation

So the system can distinguish between:
- a runnable service
- a framework to build on
- an SDK to embed
- a plugin
- a workflow/orchestrator
- a UI-first or CLI-first tool

---

## Risk Model

Risk analysis is now a first-class part of the architecture.

Instead of using a raw “high issue load” threshold, the repo evaluates:
- issue pressure relative to project size
- maintenance recency
- release risk
- adoption risk
- setup risk

This makes the shortlist and deep analysis more trustworthy.

Current surfaces for risk:
- `Caution` line in terminal shortlist
- `Risk` column in `REPO_SCOUT_RESULTS.md`
- `## Risks` section in `REPO_ANALYSIS.md`

---

## Deep Repo Analysis

When the user selects a repo, the system generates:
- `reports/REPO_ANALYSIS.md`

This report now includes:
- why the repo was selected
- first impression summary
- stack signals
- structure overview
- setup-quality signals
- risk section
- README snapshot
- latest release signal
- metrics snapshot
- language breakdown

So deep analysis is no longer just a GitHub metrics dump.

It is now a first-pass repo evaluation memo.

---

## Session Recall

The conversational agent now keeps lightweight session memory through:
- `seen`
- `history`
- `.codex/session.json`

Persisted session state includes mostly:
- prompt used
- repo name
- repo link

This allows the user to recover previously shown repos without manually saving them.

This is intentionally lightweight and keeps persistence scoped to useful recall rather than full conversation replay.

---

## Data Flow

### Terminal discovery flow

1. User runs `npm run repo`
2. Agent receives prompt
3. Intent parser builds structured intent
4. Agent generates multiple retrieval queries
5. GitHub adapter retrieves merged candidates
6. Agent preselects candidate pool
7. Candidate repos are analyzed
8. Shortlist ranking runs
9. Terminal shortlist is rendered
10. Reports are written
11. User chooses a repo, reruns, refines, or recalls prior results

### Deep analysis flow

1. User selects one shortlisted repo
2. Agent fetches:
   - repo metadata
   - languages
   - contributors
   - issues
   - README
   - root contents
   - latest release
3. Analysis report is generated
4. Report is saved to `reports/REPO_ANALYSIS.md`

---

## Why This Architecture Works

The current architecture works well because it separates:
- intent interpretation
- retrieval
- ranking
- analysis
- persistence
- transport

That means the repo can evolve each concern independently.

Examples:
- retrieval got broader without rewriting the database layer
- risk analysis got richer without changing the API surface
- session recall was added inside the agent without rewriting the domain
- deep analysis became richer by extending the GitHub adapter and report generation layer

This is exactly the kind of evolution Hexagonal Architecture is meant to support.

---

## Current MVP Boundary

This repo is now at a credible MVP boundary.

It already includes:
- natural-language repo discovery
- multi-query retrieval
- prompt-fit shortlist ranking
- README/root-content inspection
- risk analysis
- category extraction
- report generation
- session recall
- API and MCP support

The next work from here is refinement, not basic capability.

Likely next steps:
- stronger README/topic-based semantic understanding
- compare mode between shortlisted repos
- clone-based external repo inspection
- startup session controls / resume behavior
- optional frontend UI
