# Feature: CLI Search + Analyze

## Purpose
Developer-facing command-line tool for discovering and analyzing GitHub
repositories without opening a browser or hitting the API manually.

## Current command shape
npm run cli -- search "<query>" [options]
Options:
--language <lang>      Filter by language
--min-stars <n>        Minimum stars (default: 0)
--since <date>         Pushed after YYYY-MM-DD (default: 90 days ago)
--sort stars|updated|forks  (default: stars)
--random               Pick 5 random from top 100 matches
--json                 Raw JSON output, skip analyze
--top <n>              Results to show and analyze (default: 5, max: 10)

## Flow
1. Build GitHub search query from flags
2. Fetch top 100 results via searchRepos (GithubAdapter)
3. If --random: shuffle, take N. Otherwise: take top N sorted by --sort.
4. For each repo: call AnalyzeRepo.execute(owner, repo, deep=false)
5. Render table: Rank | Repo | Stars | 24h Growth | Language | Issues | Last Commit
6. Print summary line + DB save confirmation

## Data model impact
No schema changes. Writes to the existing metrics table via upsert.
Each analyze call creates/updates one row per repo.

## Search ranking design

### Current: stars descending
Simple, effective, surfaces established projects. Default because it answers
"what are the most popular repos matching X?" reliably.

### Planned: composite score
Score = (stars × 0.5) + (recentPushBonus × 0.3) + (issueHealthRatio × 0.2)

Where:
- recentPushBonus = 1.0 if pushed < 7 days, 0.5 if < 30 days, 0 otherwise
- issueHealthRatio = 1 - (openIssues / max(openIssues across result set))

This surfaces repos that are popular AND actively maintained AND not drowning
in issues. Requires fetching full repo data before ranking — adds N API calls.
Gate behind a --smart-sort flag, not the default.

### Random mode design
Shuffle is client-side (Fisher-Yates on the first 100 GitHub results).
Not truly random across all GitHub repos — biased toward GitHub's own relevance
ranking in the top 100. This is a feature: results are still related to the
query, just not always the biggest names. Good for "show me something I haven't
seen before" workflows.

## Auth + GitHub OAuth impact
Current: GITHUB_TOKEN in .env (PAT). 5,000 req/hr authenticated.
When OAuth is added: token will come from a session/keychain rather than .env.
CLI will need a `repo-analyzer auth login` command that runs the OAuth device
flow and stores the token. No changes to GithubAdapter — token injection is
already constructor-based.

## Known limitations
- Sequential analyze (not parallel): deliberate to protect rate limits.
  With 5 repos × ~3 API calls each = 15 calls per search run.
- Contributor count uses Link header approximation — may read 30 if exactly
  30 contributors exist (no next page = no header).
- No persistent search history: searches are not stored, only metrics are.

## Future work
- --smart-sort flag with composite scoring
- Search history table in DB
- `repo-analyzer auth login` for OAuth device flow
- Interactive mode: arrow-key selection from results before analyze
