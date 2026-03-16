# Feature: GitHub Adapter + Rate Limiting

## Purpose
Encapsulates all GitHub REST API calls behind RepoApiPort. Isolates Octokit
from the domain. Handles auth, pagination, and rate limit recovery transparently.

## Adapter responsibilities
- Implement every method on RepoApiPort
- Map raw Octokit response types to domain entities at the boundary
- Never let Octokit types cross into domain/ or ports/

## Port methods
```ts
getRepo(owner, repo): Promise<Repo>
getLanguages(owner, repo): Promise<Record<string, number>>
getIssues(owner, repo): Promise<number>
getContributors(owner, repo): Promise<number>
searchRepos(query, sort, perPage): Promise<SearchResult[]>
```

## Rate limit design

### GitHub limits
- Authenticated (PAT): 5,000 requests/hr (core), 30 requests/min (search)
- Search API is separately bucketed — search calls do not count against core

### withRetry implementation
private async withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T>
Attempt 1: run fn()
On 429 or 403 with x-ratelimit-remaining: 0:
Read x-ratelimit-reset header (Unix timestamp)
Wait until reset + 1000ms
Retry once (not counted against retries)
On other error:
Wait 2^attempt × 1000ms (1s, 2s, 4s)
Retry up to retries times
After all retries exhausted:
throw new RateLimitError(message, resetAt?)

### Search-specific rate limit
Search API: 30 req/min unauthenticated, 30 req/min authenticated (same).
The CLI makes one search call then up to 10 analyze calls.
Analyze = 3 core calls per repo (getRepo + getLanguages + getContributors).
Worst case: 1 search + (10 × 3) = 31 calls in one CLI run.
Core budget: 31/5000 = negligible. Search budget: 1/30 per minute = fine.

## Data model impact
None. Adapter is stateless — no DB writes, pure API translation.

## Auth + GitHub OAuth impact
Current: token passed as string to constructor.
OAuth path: GithubAdapter constructor will accept either a static token string
or a token-provider function () => Promise<string>. This keeps the adapter
unchanged for PAT users and adds a hook for OAuth token refresh without
changing the port interface.

## Known limitations
- getContributors: if Link header absent, returns array.length (max 30).
  Fix: loop pagination until no next page. Deferred — expensive for large repos.
- No request caching: same repo analyzed twice in quick succession hits GitHub
  twice. Fix: add a short TTL in-memory cache in the adapter. Deferred.

## Future work
- Pagination loop for accurate contributor count
- In-memory TTL cache (30s) for getRepo responses
- Token provider interface for OAuth support
- GitHub App support for org-level access (60,000 req/hr)
