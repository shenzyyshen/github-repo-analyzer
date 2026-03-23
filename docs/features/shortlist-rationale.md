# Feature: Shortlist Rationale

## Purpose
Make the scout shortlist decision-ready. The user should be able to understand why option `1` is above option `4` without opening every repo or running deep analysis first.

## Problem
The earlier shortlist output was too generic:
- repeated reasons like `recently active` or `manageable issue load`
- weak differentiation between ranked options
- too much emphasis on generic repo health instead of prompt fit

That made the shortlist hard to trust for prompts like:
- `I want an agent for email workflows`
- `I want a self-hosted tool for monitoring APIs and websites`

## What is analyzed before shortlist ranking
The scout ranks each candidate using the data already available from GitHub search and lightweight analysis:
- prompt-fit against the parsed intent
- repo description and name overlap with prompt concepts
- stars / adoption signal
- forks
- contributor count
- repo age and age-adjusted growth signal
- recent maintenance activity
- issue-load signal when analysis data exists

This is intentionally lighter than the deep analysis report. The shortlist should help the user decide which repos deserve deeper inspection.

## Ranking criteria

### 1. Prompt Fit
Highest weight.

Questions:
- does the repo look like a direct solution to the prompt?
- is it purpose-built, or only adaptable?
- does its description align with the user request?

### 2. Maturity
Medium weight.

Questions:
- does the repo have meaningful adoption?
- do forks and contributors suggest real usage?
- is it old enough to look established?
- is growth strong relative to age?
- is it active enough to trust?
- does it look like a real project, not just a toy?

### 3. Maintainability
Medium weight.

Questions:
- is the issue load manageable?
- is the project still active?

### 4. Tradeoff Diversity
Applied after scoring.

The shortlist should not contain five nearly identical options. If two repos are very similar, the ranking should prefer a mix of:
- direct match
- production choice
- adaptable framework
- niche option
- balanced option

## Shortlist output fields
Each shortlisted repo should show:
- `Score`
- `Best for`
- `Why`
- `Tradeoff`
- `Caution` when relevant
- `Stars`
- `Forks`
- `Contributors`
- `Age`
- `Last push`
- `Language`
- GitHub link

## Selection philosophy
The shortlist is not trying to show the newest repos. It is trying to show the best repos for the prompt.

That means:
- prompt fit matters more than raw recency
- adoption matters more than novelty
- maturity matters more than simply being updated today
- different shortlisted repos should represent different good choices, not five copies of the same answer

## Deep analysis handoff
When the user selects one shortlist item, the deep analysis report should inherit the scout reasoning:
- why it was selected
- what it is best for
- what tradeoff the user should watch for

## Current implementation direction
The scout now:
1. ranks candidates by prompt fit, adoption, maturity, maintainability, and age-adjusted growth
2. assigns a shortlist archetype (`direct match`, `production choice`, `adaptable framework`, `niche option`, `balanced option`)
3. applies a diversity penalty so the top 5 are not all the same archetype
4. writes the shortlist rationale to terminal output and `REPO_SCOUT_RESULTS.md`

## Future work
- compare mode between two shortlisted repos
- better intent-aware tradeoff generation
- confidence-aware explanation quality
- richer domain archetypes for agent/tool/framework/server distinctions
