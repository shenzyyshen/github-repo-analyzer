# Feature: MCP Server + AI Tools

## Purpose
Expose the analyzer as a set of tools consumable by AI assistants (Claude Desktop,
Claude API, any MCP-compatible client). Allows natural-language workflows like
"analyze the top 5 Rust web frameworks" without writing CLI commands.

## Transport
stdio — server runs as a subprocess managed by the MCP host.
Configured in claude_desktop_config.json.

## Current tools
analyze_repo(owner: string, repo: string, deep?: boolean)
→ calls AnalyzeRepo.execute()
→ returns Metrics as JSON text
get_trending(language?: string)
→ calls GetTrending.execute()
→ returns TrendingRepo[] as JSON text

## Planned tool: natural language search
search_repos(prompt: string, top?: number)
→ translates prompt to GitHub search query via Claude API
→ calls searchRepos on GithubAdapter
→ calls AnalyzeRepo on each result
→ returns ranked results as JSON text

### AI query translation design

Input:  "find fast Rust HTTP frameworks with active development"
Output: "http framework language:rust stars:>500 pushed:>2024-01-01"

Translation prompt template:
You are a GitHub search query builder. Convert the user's natural language
request into a valid GitHub repository search query string.
Rules:

Use language:X for programming language filters
Use stars:>N for minimum star filters
Use pushed:>YYYY-MM-DD for recency filters
Use topic:X for topic filters
Do not add qualifiers the user didn't imply
Return ONLY the query string, no explanation

User request: {prompt}
Query:

The tool handler calls the Anthropic API (claude-haiku-3 for speed/cost),
parses the response as a raw string, passes it to searchRepos.

### Failure handling
If Claude API call fails: fall back to using the raw prompt as the search
query (GitHub search is tolerant of natural language — it degrades gracefully).
Log the fallback to stderr so the MCP host can surface it.

## Data model impact
No schema changes. search_repos writes to metrics table via AnalyzeRepo,
same as the CLI.

## Auth + GitHub OAuth impact
search_repos tool will need a GITHUB_TOKEN. Currently sourced from env.
When OAuth is added, token provider interface in GithubAdapter covers this
without changes to the MCP tool handlers.

Anthropic API calls require ANTHROPIC_API_KEY in env. Add to .env.example
as optional (only needed if using search_repos tool).

## Known limitations
- stdio transport: one MCP client at a time. Not suitable for multi-user server.
- Tool outputs are plain JSON strings — no streaming, no partial results.
- AI translation quality varies; exotic queries may produce poor GitHub queries.

## Future work
- HTTP transport option for multi-client server mode
- Streaming tool responses (MCP supports it in newer SDK versions)
- search_repos tool with AI query translation (see above)
- Tool: get_repo_history(owner, repo) once metrics_history table exists
- Tool: compare_repos(repos: string[]) — side-by-side metrics diff
