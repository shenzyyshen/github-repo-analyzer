# Search Criteria Review

Generated: 2026-03-30

## Summary

The most recent functional commits do not materially change prompt-to-filter parsing in `src/cli/intent.ts`.
The stronger behavior changes are in `src/cli/agent.ts`, where retrieval, preselection, and shortlist ranking increasingly reward maturity, adoption, setup signals, README/topic matches, and shortlist diversity.

That means the system is not only trying to find the best repo for the prompt. It is also trying to return a varied shortlist of credible repos, which can push the top results away from the single closest prompt match.

## Current Prompt-To-Filter Flow

1. The planner produces a base search object with:
   - `query`
   - `language`
   - `minStars`
   - `since`
   - `sort`
   - `top`
   - `random`
2. `inferFilters()` in `src/cli/intent.ts` adds inferred constraints from the raw prompt:
   - language detection
   - activity recency if the prompt asks for active maintenance
   - license for MIT or Apache
   - `production-ready` raises `minStars` to at least `1000`
   - `lightweight` and `well documented` append query terms
   - concept boost terms append more search terms
3. `buildGitHubQuery()` in `src/cli/agent.ts` converts that into GitHub qualifiers:
   - `language:<lang>`
   - `stars:>N`
   - `pushed:>YYYY-MM-DD`
   - `license:<id>`
4. `buildRetrievalQueries()` generates up to 5 query variants from the prompt.
5. `searchMergedCandidates()` searches all variants and merges unique repos.
6. `preselectCandidates()` scores the merged pool before deep analysis.
7. `rankShortlist()` scores analyzed repos again and then applies diversity penalties so the final shortlist is not too repetitive.

## Exact Filters Inferred Today

From `src/cli/intent.ts`, the user prompt can currently infer:

- `Language`
- `Activity: updated in the last 90 days`
- `License: MIT`
- `License: Apache-2.0`
- `Size/Maturity: lightweight`
- `Size/Maturity: production-ready`
- `Size/Maturity: well documented`
- `Purpose: derived concept labels or normalized purpose terms`

Concept expansion currently recognizes:

- local LLM / inference
- desktop app
- self-hosted
- REST API
- HTTP client
- real-time / websocket
- monitoring / observability
- developer tooling

## What Changed Recently

The latest commits `81e7a5b` and `064a3cf` are session/history UX changes and do not change search criteria.

The more important behavior changes happened earlier:

- `5fb2cef`: multi-query retrieval for broader discovery
- `6a4c447`: rank a larger candidate pool before final shortlist
- `e842425`: README/topic/root-content signals added to ranking
- `e5ca701`: repo category extraction added to ranking and recommendation text
- `0267cd8`: diversity penalties added so shortlist items vary by fit type, tradeoff, and risk

## Why Results May Feel Off

The current system optimizes for a credible diversified shortlist, not a strict "single best repo for my exact prompt" objective.

The main reasons:

- `preselectCandidates()` rewards stars, forks, age, and maintenance before full prompt fit dominates.
- `rankShortlist()` adds strong non-prompt factors such as adoption, maturity, releases, and setup signals.
- `rankShortlist()` then penalizes repeated fit types, tradeoffs, and risks, which explicitly favors variety over the closest repeated match pattern.
- concept expansion can broaden the query away from the user's exact wording.

## Most Relevant Code Paths

- `src/cli/intent.ts`
  - `parseIntent()`
  - `inferFilters()`
  - `buildRetrievalQueries()`
  - `buildBroaderSearchQuery()`
- `src/cli/agent.ts`
  - `buildGitHubQuery()`
  - `searchMergedCandidates()`
  - `preselectCandidates()`
  - `rankShortlist()`

## Recommendation

If the goal is "find me the best repo based on my prompt", the shortlist logic should separate:

- search filters: only what the user explicitly asked for or what is safely inferred
- candidate scoring: exact prompt fit should dominate
- diversity logic: optional for positions 2-5, but not for rank 1

As written, rank 1 can still be influenced by diversity-oriented shortlist behavior and strong popularity/maturity priors.
