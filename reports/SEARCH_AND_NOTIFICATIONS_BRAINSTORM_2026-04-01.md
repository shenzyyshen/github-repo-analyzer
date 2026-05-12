# Search And Notifications Brainstorm

Generated: 2026-04-01

## Problem Statement

The current product is trying to do three things at once:

1. find prompt-relevant repositories
2. prefer credible / mature repositories
3. diversify the shortlist

That combination can produce results that are credible but not current or not tightly aligned to the prompt.

Example failure:
- prompt about LLM tips or current AI tooling
- result from 6 years ago
- result about a tangential topic like chess

## Why The Current Behavior Drifts

### 1. Broad retrieval can move away from the prompt

`buildRetrievalQueries()` generates up to 5 variants, including broader concept-only searches and hybrid queries.

Relevant code:
- `src/cli/intent.ts`

Impact:
- useful when the prompt is vague
- harmful when the prompt is already specific and time-sensitive

### 2. Preselection rewards forks and maturity before exact relevance wins

`preselectCandidates()` adds:
- stars bonus
- forks bonus
- maturity bonus
- maintenance bonus

Relevant code:
- `src/cli/agent.ts`

Impact:
- older established repos survive early screening
- newer but highly relevant repos can be filtered out

### 3. Rank 1 is still influenced by diversity logic

`rankShortlist()` builds a strong mixed-objective score and then applies penalties for repeated fit type, tradeoff, and risk pattern.

Relevant code:
- `src/cli/agent.ts`

Impact:
- the top result is not always the closest answer to the user prompt
- the system behaves more like a curator than a strict answer engine

### 4. Fork count is a larger signal than the desired product direction

The current shortlist philosophy still treats forks as meaningful adoption.

Impact:
- fork-heavy but older framework repos can outrank better modern repos
- this does not match the desired user preference

## Recommended Product Direction

Split the system into explicit modes instead of one ranking strategy.

### Mode A: Best Match

Goal:
- return the single best repo for the prompt

Rules:
- prompt fit dominates
- diversity does not affect rank 1
- broadening is limited
- recentness matters more for fast-moving domains like AI / LLM / agents

Use for:
- "best repo for X"
- "best open source Y"
- "best current LLM tips / agent framework / Claude tooling"

### Mode B: Best Shortlist

Goal:
- return 3-5 strong options with tradeoffs

Rules:
- use diversity only for positions 2-5
- keep rank 1 as pure best-match score
- include credibility and maturity signals

Use for:
- "show me options"
- "compare good repos for X"

### Mode C: Watch / Notifications

Goal:
- alert users when selected entities publish something new or when tracked categories get meaningful new repos

Rules:
- entity tracking is first-class
- recency is strict
- category quality floor is high

Use for:
- "notify me on new Claude repos"
- "watch Anthropic, OpenAI, LangChain, Hugging Face"
- "watch top agent companies and top open-source AI orgs"

## Search Changes To Prioritize

### 1. Add domain freshness sensitivity

Some prompts should force recency harder than others.

High-freshness domains:
- llm
- ai agents
- claude
- openai
- model context protocol
- inference
- rag
- evals
- embeddings

Default rule:
- if prompt hits a high-change domain, default `since` to 12 months or 6 months, not 90 days only as a soft add-on
- apply a steep freshness penalty for very old repos unless they are extremely dominant and still actively updated

### 2. Replace broad query expansion with staged retrieval

Suggested flow:
1. strict search from exact prompt terms
2. strict search from README/topic-aware synonyms
3. broader concept search only if the strict pool is too small

Important rule:
- do not mix broad-search candidates into the same top ranking unless they passed a stronger prompt-fit threshold

### 3. Remove forks from the main score or reduce them to a weak tie-breaker

Desired adoption priority:
1. stars
2. contributor count
3. account quality
4. recent activity
5. releases / tags
6. forks only as a weak secondary signal

### 4. Separate "exact relevance" from "quality floor"

Use a two-step decision:

Step 1: quality floor
- not archived
- not too stale
- minimum stars
- contributor or release signal
- enough README/topic match

Step 2: ranking
- exact prompt fit
- freshness
- stars
- account quality
- maintenance

This is better than mixing all of them together early.

## Better Ranking Criteria

Recommended weighted score for fast-moving domains:

- prompt fit: 40%
- freshness / recent update / recent release: 20%
- stars: 20%
- account quality: 10%
- maintenance quality: 10%

Recommended weighted score for slower-moving infra domains:

- prompt fit: 35%
- stars: 25%
- maintenance quality: 15%
- account quality: 10%
- freshness: 10%
- repo maturity: 5%

### Account quality should become a first-class signal

Instead of relying on forks, score the owner account.

Signals for account quality:
- organization vs individual
- verified organization / well-known company
- multiple high-star repos in same domain
- sustained activity over time
- follower count if available
- company / organization metadata
- website domain matching a known company
- account has several repos above thresholds like 1k, 5k, 10k stars

## How To Identify "Huge Repo Accounts"

Create an owner profile model.

### Proposed owner-level fields

- `ownerLogin`
- `ownerType` (`User` or `Organization`)
- `displayName`
- `company`
- `blogOrWebsite`
- `location`
- `followers`
- `publicRepos`
- `avatarUrl`
- `isVerifiedLike`
- `knownCompanySlug`
- `highStarRepoCount`
- `topRepoStars`
- `totalTrackedStars`
- `lastObservedAt`

### Heuristics for "great account"

Tier 1: elite
- known company or foundation
- or at least 3 repos above 5k stars
- or at least 1 repo above 50k stars and clear domain relevance

Tier 2: strong
- at least 2 repos above 1k stars
- active in the target domain
- recent updates within 6-12 months

Tier 3: promising
- newer account with 1 breakout repo
- good README / release / contributor signals

### How to obtain it from GitHub

Likely GitHub API sources:
- repository owner metadata
- organization endpoints
- user endpoints
- repository list per owner
- topics, releases, pushed dates, stargazers

Practical method:
1. when a repo is shortlisted, fetch owner profile
2. fetch top repos for that owner
3. compute owner reputation summary
4. cache the owner profile locally

## Notifications Design

There are two notification types worth building.

### 1. Entity watchlists

User examples:
- "notify me when Anthropic publishes a new repo"
- "notify me on Claude repos"
- "watch OpenAI and Hugging Face"

Tracking target types:
- GitHub owner login
- company slug
- topic / keyword
- custom query

Examples:
- owner watch: `anthropics`, `openai`, `huggingface`
- keyword watch: `claude`, `model-context-protocol`, `coding-agent`
- hybrid watch: owner in known companies plus keyword match

### 2. Category watchlists

User examples:
- "notify me about new top MCP repos"
- "watch newly trending agent frameworks"

Rule:
- only alert if a new repo clears a quality threshold

Possible threshold:
- stars >= 100 within first 30 days
- or stars >= 500 overall
- or owner is elite-tier

## Notification Trigger Logic

### New repo trigger

Trigger when:
- tracked owner creates a repo
- repo matches optional keyword/topic filters
- repo passes quality floor

### Significant update trigger

Trigger when:
- tracked repo gets a release
- or stars jump materially
- or repo becomes active again after dormancy

### Suggested anti-noise controls

- daily digest by default
- immediate alerts only for elite owners
- deduplicate by repo
- suppress alerts for forks
- suppress archived repos

## Storage / Data Model Direction

Current schema only stores repo and metrics snapshots.

Relevant code:
- `prisma/schema.prisma`

Add models like:

- `OwnerProfile`
- `WatchTarget`
- `WatchSubscription`
- `ObservedRepo`
- `RepoSnapshot`
- `NotificationEvent`

### Minimal first-pass schema idea

- `OwnerProfile`
  - owner login, type, company, followers, score
- `WatchTarget`
  - kind (`owner`, `company`, `keyword`, `query`, `topic`)
  - value
- `WatchSubscription`
  - target id
  - delivery mode
  - active flag
- `NotificationEvent`
  - repo full name
  - target id
  - event kind
  - short summary
  - created at
  - sent at

## Example User-Facing Filters

These should be explicit, not hidden in heuristics.

### Search filters

- exact match vs broad search
- fresh only
- updated within 30 / 90 / 180 / 365 days
- created within 30 / 90 / 180 / 365 days
- minimum stars
- owner type: user / org / company
- known-company only
- exclude forks
- exclude archived
- language
- topic
- has releases
- minimum contributor count

### Ranking preferences

- prefer newest
- prefer most starred
- prefer company-backed
- prefer active maintenance
- prefer exact prompt fit

### Notification filters

- notify on new repos from owner
- notify on new repos from company
- notify on repos matching keyword
- notify only if stars exceed threshold
- notify only if updated in last N days

## Short Link / Example File Idea

Create a saved watchlist export file with:
- short label
- target type
- value
- optional filters
- short shareable link slug

Example:

```json
{
  "label": "Claude Ecosystem",
  "targets": [
    { "kind": "keyword", "value": "claude" },
    { "kind": "owner", "value": "anthropics" }
  ],
  "filters": {
    "excludeForks": true,
    "minStars": 50,
    "updatedWithinDays": 365,
    "ownerTierAtLeast": "strong"
  },
  "examples": [
    "anthropics/*",
    "repos mentioning claude in README/topics",
    "new agent repos tied to claude integrations"
  ],
  "shortSlug": "claude-ecosystem"
}
```

This could later back:
- a CLI preset file
- an API payload
- a shareable GUI link

## Concrete Implementation Plan

### Phase 1: fix search quality

1. keep rank 1 pure best-match
2. move diversity penalties to ranks 2-5 only
3. reduce or remove forks from preselection and shortlist score
4. add stronger freshness handling for AI / LLM / agent prompts
5. switch broadening to staged fallback, not equal-weight retrieval

### Phase 2: add owner intelligence

1. fetch owner profile for shortlisted repos
2. compute owner quality tier
3. expose `ownerType`, `company`, and `ownerTier` in shortlist output
4. add search filters for `company-backed` and `organization-only`

### Phase 3: add watchlists

1. introduce watch target models
2. add CLI commands to save watches
3. add periodic poller
4. generate notification events and digest output
5. export watch presets as JSON with a short slug

## Best Immediate Next Step

If the goal is maximum result quality improvement fast, the best next change is:

1. make rank 1 a strict best-match score
2. remove forks from primary ranking
3. add freshness-sensitive rules for AI / LLM prompts

That will address the current failure mode more directly than adding notifications first.
