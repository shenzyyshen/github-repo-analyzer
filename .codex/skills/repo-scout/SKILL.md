---
name: repo-scout
description: Use for natural-language repo discovery and shortlisting. Triggers on "find repos", "search GitHub", "discover projects", or "top repos for".
---

# Repo Scout Skill

## Purpose
Translate a natural-language request into a GitHub search query, fetch candidates, analyze top results, and return a ranked shortlist.

## Inputs
- prompt: string
- top: number (default 5, max 10)
- filters: language, minStars, since, sort

## Steps
1. Translate prompt → GitHub search query (language/stars/pushed filters when implied)
2. Call GitHub search API (top 100)
3. Apply filters and select top N (or random if requested)
4. Analyze each repo via AnalyzeRepo.execute(owner, repo, deep=false)
5. Rank results and attach brief rationale

## Output
Save a markdown report to `./reports/REPO_SCOUT_RESULTS.md` with:
- A timestamp at the top
- A structured markdown table with columns: Repo, Description, Stars, Language, Last Commit, Why Recommended, Score (1-10), Link
- A short conversational summary explaining the overall recommendation and trade-offs

## Guardrails
- Respect rate limits; analyze sequentially
- Do not exceed top 10
- Fail gracefully per-repo; continue the batch
