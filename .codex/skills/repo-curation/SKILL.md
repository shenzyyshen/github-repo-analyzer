---
name: repo-curation
description: Use to curate and rank a list of GitHub repositories based on popularity, recency, and health signals. Triggers on "curate repos", "rank results", "shortlist", or "best options".
---

# Repo Curation Skill

## Purpose
Given a list of candidate repos, produce a short ranked list with rationale and clear selection criteria.

## Inputs
- repos: list of repo identifiers or result objects
- criteria: stars, recency, issue health, language match, activity
- top: number (default 5, max 10)

## Steps
1. Normalize repo inputs into a consistent shape
2. Apply ranking criteria (stars + recency + issue health)
3. Select top N and generate brief rationale per repo
4. Flag any outliers or stale repos

## Output
Save a markdown report to `./reports/REPO_CURATED.md` with sections:
- Criteria
- Ranked Results (table)
- Rationale
- Outliers / Caveats

## Guardrails
- Be explicit about scoring criteria
- Prefer recent activity over raw stars when close
- Do not exceed top 10
