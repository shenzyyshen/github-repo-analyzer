# Best Of The Best Repo Search — Action Plan

Generated: 2026-04-04
Source: system-context-v2 pasted by user

## Objective

Turn the current repo search product into a staged repo-intelligence system that:

- returns one high-confidence best match or a tight shortlist
- aggressively removes weak repos before ranking
- scores repo quality transparently
- detects decay and dependency risk
- builds toward watch/notification workflows and always-on repo radar

## Product Direction

The source document defines a shift in product posture:

- from "GitHub search wrapper" to "repo intelligence engine"
- from broad ranked lists to narrow, defensible recommendations
- from one-off search to continuous repo awareness

This means the implementation should prioritize correctness, explainability, and filtering discipline over search volume or result diversity.

## Delivery Principles

- Rank 1 must always be the pure best-match result
- Diversity applies only after rank 1 in shortlist mode
- Hard gates must remove obvious low-quality repos before scoring
- Freshness must be domain-aware, not based on recent push alone
- Every returned repo needs a human-readable explanation
- Data model changes are required early because snapshots, owner intelligence, and dependency mapping are foundational

## Recommended Execution Order

### Phase 1 — Lock Product Semantics

Goal: freeze the behavior contract before implementation spreads across the codebase.

Actions:

1. Define the three operating modes in code and docs:
   - `best_match`
   - `best_shortlist`
   - `watch` as planned/not yet shipped
2. Formalize prompt-intent classification output:
   - artifact type
   - domain speed
   - specificity
   - intent mode
   - freshness override
   - owner preference
3. Define default thresholds for:
   - Stage 2 hard gates
   - Stage 3 prompt-fit threshold
   - Health Score labels
   - Decay labels
4. Decide which signals are mandatory for MVP and which can be stubbed initially.

Deliverables:

- product spec for ranking behavior
- config schema for thresholds and weights
- enum/types for modes, tiers, labels, and overrides

### Phase 2 — Rebuild Retrieval as a Staged Pipeline

Goal: replace any flat search-and-rank flow with explicit stage boundaries.

Actions:

1. Implement Stage 0 intent classification before search.
2. Implement Stage 1 broad retrieval to collect 150–200 raw candidates.
3. Implement Stage 2 hard quality floor:
   - archived
   - fork policy
   - README existence
   - README minimum quality
   - domain-relative staleness
   - star floor
   - decay disqualifier
4. Implement Stage 3 prompt-fit scoring and threshold drop.
5. Implement Stage 4 full composite ranking.
6. Implement Stage 5 final output filtering:
   - deduplication
   - alternative detection
   - final decay pass
   - explanation generation

Deliverables:

- explicit pipeline stages with typed inputs/outputs
- logs/metrics for pool size after each stage
- test fixtures for thin-pool and overfull-pool behavior

### Phase 3 — Build the Scoring Engine

Goal: make ranking explainable and tunable.

Actions:

1. Implement domain-aware ranking profiles:
   - fast-moving domains
   - slower-moving domains
2. Add intent-based weight mutations for:
   - latest/new/current
   - stable/production/battle-tested
   - company-name prompts
   - language requirements
   - beginner/tutorial prompts
3. Implement Prompt Fit scoring from:
   - repo name
   - description
   - README
   - topics
   - language
   - artifact type
4. Implement Repo Health Score with component breakdown:
   - README quality
   - stars velocity
   - dependency freshness
   - maintenance quality
   - owner tier

Deliverables:

- scoring module with per-signal breakdown
- explainable output for each subscore
- weight configuration isolated from application logic

### Phase 4 — Add Freshness, Decay, and Dependency Intelligence

Goal: make the system robust against stale but famous repos.

Actions:

1. Implement the domain clock and freshness composite:
   - last push
   - last release
   - README update recency
   - terminology currency
   - sustained activity
   - stars velocity trend
2. Implement Decay Detection and labels:
   - Healthy
   - Slowing
   - Fading
   - Abandoned
3. Implement dependency-health analysis:
   - identify core dependencies
   - detect archived/abandoned upstreams
   - detect major version lag
   - penalize supply chain risk in Health Score

Deliverables:

- freshness evaluator
- decay evaluator
- dependency-health evaluator
- surfaced `Dependency Health` output field

### Phase 5 — Build Owner Intelligence

Goal: score trustworthiness of the repo owner instead of treating all owners equally.

Actions:

1. Create owner profiles and owner tiering:
   - Elite
   - Strong
   - Promising
   - Weak
2. Score owner quality from:
   - org vs individual
   - known company/foundation status
   - populated profile metadata
   - multiple successful repos
   - followers
   - sustained output over time
3. Feed owner signals into both Health Score and final ranking.

Deliverables:

- owner profile model
- owner tier computation job
- owner explanation strings for result output

### Phase 6 — Upgrade Data Model

Goal: support velocity, decay, and explainability with durable historical data.

Actions:

1. Add or design the required entities:
   - `repositories`
   - `repo_snapshots`
   - `repo_health_scores`
   - `owner_profiles`
   - `dependency_maps`
   - `watch_targets`
   - `watch_subscriptions`
   - `notification_events`
   - `search_history`
   - `trend_snapshots`
2. Define ingestion/update cadence for snapshots and trends.
3. Backfill enough historical data to validate velocity and decay logic.

Deliverables:

- schema migration plan
- ingestion/update jobs
- retention strategy for historical snapshots

### Phase 7 — Improve Output Trust and UX

Goal: make recommendations feel expert, auditable, and actionable.

Actions:

1. Implement required output block:
   - health
   - decay
   - match reason
   - freshness note
   - owner tier
   - dependency health
   - prompt-fit percentage
   - caveat note
2. Add alternatives block when close competitors exist.
3. Add confidence score:
   - High
   - Medium
   - Low
4. Add `--explain` mode for detailed scoring breakdown.

Deliverables:

- final output renderer
- explanation renderer
- confidence scoring logic

### Phase 8 — Add Trend and History Features

Goal: create the bridge from point-in-time search to ongoing repo radar.

Actions:

1. Implement `--trends` using the Stage 1 pool filtered by Stage 2.
2. Implement local search history and re-run commands.
3. Capture prompt corrections to improve classifier tuning.
4. Surface related repos from the same owner when relevant.

Deliverables:

- trend radar output
- history storage and rerun support
- feedback log for prompt corrections
- owner graph / related repo output

### Phase 9 — Prepare Watch / Notifications

Goal: turn trend and quality logic into alerting foundations.

Actions:

1. Define watch targets for owners and categories.
2. Reuse Stage 2+ quality gates for notification eligibility.
3. Trigger alerts only for repos that clear the quality floor.
4. Store alert reasons and timestamps for auditability.

Deliverables:

- watch-target model
- alert evaluation rules
- notification event schema

## Suggested Milestones

### Milestone 1 — Ranking Foundation

Ship:

- Stage 0 to Stage 5 pipeline skeleton
- prompt-fit scoring
- hard quality gates
- best-match and shortlist modes
- explanation output v1

Success criteria:

- rank 1 is meaningfully better than current output
- low-quality repos are filtered out early
- pipeline exposes stage counts for debugging

### Milestone 2 — Intelligence Layer

Ship:

- Health Score
- owner tiers
- freshness composite
- decay labels
- alternatives block

Success criteria:

- results are explainable and defensible
- stale but famous repos stop dominating rankings

### Milestone 3 — Historical Awareness

Ship:

- repo snapshots
- trend snapshots
- stars velocity
- dependency-health scoring
- confidence scoring

Success criteria:

- system can detect rising vs fading repos with evidence
- dependency risks appear in output

### Milestone 4 — Radar Foundation

Ship:

- trend radar
- search history and rerun
- watch-target schema
- notification-event plumbing

Success criteria:

- product begins moving from search flow to continuous awareness

## Highest-Risk Areas

- Historical data dependency: decay, velocity, and trend logic will be weak without snapshots.
- Dependency mapping complexity: accurate cross-repo dependency analysis may require domain-specific parsers.
- README quality heuristics: naive scoring could be noisy without careful tuning.
- Intent classification errors: poor classification will distort weights and freshness handling.
- Thin-result prompts: aggressive gates can produce empty or weak pools if fallback rules are not well controlled.

## MVP Recommendation

Build the MVP around the minimum set that changes result quality fast:

1. Stage-based retrieval pipeline
2. Prompt-intent classification
3. Hard quality floor
4. Prompt-fit scoring
5. Freshness by domain clock
6. Repo Health Score v1
7. Explanation output

Delay until after MVP if needed:

- full dependency graph sophistication
- watch/notifications
- owner graph exploration
- classifier feedback loop automation

## Immediate Next Tasks

1. Audit the current codebase against the nine phases above.
2. Identify which current modules map to search, ranking, scoring, persistence, and output.
3. Produce a gap report:
   - what already exists
   - what needs refactor
   - what is net new
4. Convert this action plan into implementation tickets grouped by milestone.

## Recommended Folder Output

Suggested external brainstorm folder name:

- `best-of-the-best-action-plan-2026-04-04`

Suggested file name:

- `action-plan.md`
