---
name: repo-analysis
description: Use when analyzing a GitHub repo, auditing structure, reviewing README, checking dependencies, or generating a codebase report. Triggers on "analyze this repo", "review the codebase", "audit dependencies", "what does this project do".
---

# Repo Analysis Skill

## Steps
1. Read README.md and any docs/ folder
2. List directory tree to map structure
3. Read the dependency manifest
4. Check .github/workflows/ for CI config
5. Check for test directories and linting config
6. Scan for .env files or hardcoded secrets
7. Write the full report to ./reports/REPO_ANALYSIS.md

## Output
Save a markdown report to `./reports/REPO_ANALYSIS.md` with these sections:
- Project Summary
- Tech Stack
- Structure Overview
- Strengths
- Gaps
- Quick Wins
