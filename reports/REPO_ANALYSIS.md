# Repo Analysis

## Project Summary

This repository has evolved from a GitHub metrics analyzer into a terminal-first AI-assisted GitHub repo discovery and curation tool. The current product vision is natural-language repo scouting: translate a user prompt into several GitHub searches, broaden retrieval, rank candidates, explain tradeoffs and risks, and optionally generate a deeper markdown report for one selected repo.

The analyzer output is therefore not code-quality scoring or dependency graphs. The lightweight/core analyzer returns repo metadata and activity metrics such as stars, 24h star growth, language breakdown, open issues, contributors, and last commit. The deeper scout-driven analysis writes a markdown report with project summary, stack signals, structure overview, setup signals, risks, README snapshot, repository metadata, and metrics snapshot.

The most likely intended users are developers, technical founders, DevRel, and internal platform/tooling teams who need to discover and compare open-source repos quickly. The terminal-first workflow and MCP support suggest this is optimized for technical users rather than a broad consumer audience.

## Tech Stack

- TypeScript on Node.js 20+ ([package.json](/Users/shenmay/Projects_/repo-metrics-hex/package.json))
- Express for HTTP delivery ([src/server/express.ts](/Users/shenmay/Projects_/repo-metrics-hex/src/server/express.ts))
- MCP server over stdio for AI-client integration ([src/server/mcp.ts](/Users/shenmay/Projects_/repo-metrics-hex/src/server/mcp.ts))
- Octokit GitHub REST client ([src/adapters/github/GithubAdapter.ts](/Users/shenmay/Projects_/repo-metrics-hex/src/adapters/github/GithubAdapter.ts))
- Prisma + PostgreSQL for persistence ([src/adapters/database/PrismaAdapter.ts](/Users/shenmay/Projects_/repo-metrics-hex/src/adapters/database/PrismaAdapter.ts), [prisma/schema.prisma](/Users/shenmay/Projects_/repo-metrics-hex/prisma/schema.prisma))
- OpenAI SDK is present and used in the conversational CLI planner ([src/cli/agent.ts](/Users/shenmay/Projects_/repo-metrics-hex/src/cli/agent.ts))

## Structure Overview

- Domain entities and use cases live in `src/domain/`
- Ports live in `src/ports/`
- Driven adapters live in `src/adapters/`
- Driving adapters / delivery surfaces live in `src/cli/` and `src/server/`
- App wiring happens in `src/index.ts`

Main ports:
- `RepoApiPort`: repo metadata, languages, issues, contributors, README, root contents, latest release, search
- `MetricsRepoPort`: save metrics, load metrics, trending queries

Main adapters:
- GitHub adapter via Octokit
- Prisma/PostgreSQL adapter
- CLI adapter
- Express API adapter
- MCP adapter

## Strengths

- Clear hexagonal separation between domain, ports, adapters, and delivery surfaces
- Strong product direction: retrieval breadth + shortlist precision + explainable tradeoffs
- Same core capabilities exposed through CLI, REST, and MCP
- AI is used where it helps most: prompt interpretation/planning, with GitHub retrieval and ranking still grounded in explicit signals
- Repo analysis output is decision-oriented for choosing repos, not just raw metrics dumping

## Gaps

- The formal domain use cases in `src/domain/usecases/` are still relatively narrow compared with the richer scout logic in `src/cli/agent.ts`
- No evidence in the repo of production usage metrics, telemetry, or real user adoption numbers
- No LICENSE file exists even though README mentions MIT
- README/docs still reflect two overlapping product narratives: earlier "repo analyzer" and current "repo scout"
- No clear evidence this is deployed live beyond local/API/MCP runtime instructions

## Quick Wins

- Unify the narrative across README and docs around the current scout/discovery product
- Promote shortlist ranking and deep report generation into clearer service/domain modules rather than concentrating them in the CLI agent
- Add a real `LICENSE` file if the project is meant to be open source
- Add lightweight usage instrumentation if impact metrics are important
- Clarify intended primary user segment in README: developer scout tool, founder research tool, or internal tooling assistant
