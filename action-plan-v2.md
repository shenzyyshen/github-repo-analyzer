# Best Of The Best Repo Search — Action Plan v2

Generated: 2026-04-04
Context: Solo developer, working MVP, architecture-first priority

---

## What Was Wrong With v1

The previous action plan was written for a team, not a solo developer.
It had 9 phases, vague deliverables, and the wrong execution order.
This version is a ground-up rewrite for one person who wants the architecture correct before building.

Core mistakes fixed:

- Schema was Phase 6. It is now Phase 1. Nothing else starts without it.
- Phase 1 was "lock semantics in docs." That is a procrastination trap. Replaced with a real build task.
- Phases were too fat to finish or verify. Each phase now has a hard "done looks like this" exit criterion.
- Unlock dependencies were missing. Nothing starts until its prerequisites are complete.
- Risk areas were buried. They are now surfaced early with explicit mitigation actions.
- MVP section confused "don't build yet" with "don't architect for yet." Those are different decisions. Fixed.

---

## Architectural Principles (read before building anything)

1. Schema is the foundation. Every feature is downstream of the data model. Build it first, lock it, then build on top.
2. Define pipeline interfaces before pipeline logic. Know what flows in and out of each stage before implementing any stage.
3. Build gates before retrieval breadth. Stage 2 filtering calibrates everything else. Run it against real data first.
4. Prompt fit before composite scoring. The highest-weight signal must be correct before adding complexity.
5. Health Score stubs are correct architecture. If a component lacks data, return a neutral score. The interface is complete. The implementation fills in over time.
6. Decay requires two snapshots. Do not build decay logic until you have run at least one snapshot cycle and have real delta data.
7. Output layer is last. A polished explanation on top of a weak pipeline is noise. Build it when scores underneath are trustworthy.

---

## Unlock Dependency Map

This is the most important table in this document.
Nothing starts until its prerequisites column is satisfied.

| Phase | Prerequisite phases |
|---|---|
| Phase 1 — Schema | None. Starts immediately. |
| Phase 2 — Pipeline interfaces | Phase 1 complete |
| Phase 3 — Hard quality gates | Phase 1, Phase 2 |
| Phase 4 — Broad retrieval | Phase 2, Phase 3 (gates calibrate retrieval breadth) |
| Phase 5 — Prompt-fit scoring | Phase 2, Phase 4 |
| Phase 6 — Health Score v1 | Phase 1, Phase 3, Phase 5 |
| Phase 7 — Owner intelligence | Phase 1, Phase 6 |
| Phase 8 — Freshness + Decay | Phase 1, first snapshot cycle complete |
| Phase 9 — Dependency awareness | Phase 1, Phase 6, dependency data source confirmed |
| Phase 10 — Composite ranking | Phase 5, Phase 6, Phase 7, Phase 8 |
| Phase 11 — Output + explanation layer | Phase 10 complete |
| Phase 12 — Trend radar + history | Phase 10, Phase 11 |
| Phase 13 — Watch / notifications | Phase 12, snapshot cadence stable |

Do not skip ahead. Each phase produces data or interfaces that the next phase depends on.

---

## The Three Spikes (do these before Phase 1)

A spike is a short investigation to resolve a genuine unknown before committing to architecture.
These three unknowns have the highest risk of derailing the build if left unresolved.

### Spike A — README Quality Scoring

Question: how noisy is README quality scoring against real repo data?

Actions:
- Pull 30 repos from your existing MVP output
- Score them manually on: length, keyword overlap, has install instructions, has usage examples
- Build a naive scorer and compare its output to your manual scores
- Measure false positive and false negative rate

Done looks like: you know whether naive scoring is usable or requires tuning, and you have a baseline threshold value.

Time box: 1 day.

---

### Spike B — Dependency Mapping Data Source

Question: where does dependency data actually come from, and how reliable is it?

Options to evaluate:
- GitHub Dependency Graph API (requires repo to have dependency graph enabled)
- Parsing `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml` directly from repo contents
- Libraries.io API as a secondary source
- Combination

Actions:
- Test GitHub Dependency Graph API against 10 repos in your target domains
- Check coverage — what percentage of repos have it enabled?
- If coverage is low, test direct file parsing as fallback
- Decide: full implementation, partial stub, or defer entirely

Done looks like: you have a confirmed data source, know its coverage and limitations, and have decided whether to implement in MVP or stub.

Time box: 1 day.

---

### Spike C — Intent Classification Accuracy

Question: does prompt-intent classification produce reliable output against real prompts?

Actions:
- Write 25 real prompts ranging from narrow to broad, fast domain to slow domain
- Run each through your classification logic
- Record: artifact_type, domain_speed, specificity, intent_mode, freshness_override
- Manually score each classification as correct / acceptable / wrong
- Identify which signal categories fail most

Done looks like: you know classification accuracy across prompt types and have identified the weight mutation rules that are safe to implement vs those that need more tuning.

Time box: 1 day.

---

## Phase 1 — Schema (foundation, nothing else starts without this)

Goal: design and ship the full data model before writing any pipeline logic.

Every feature in this system is downstream of the schema.
Getting this wrong means refactoring for months.
Getting this right means every subsequent phase builds cleanly on top.

### Required entities

| Entity | Purpose | MVP or future |
|---|---|---|
| `repositories` | Canonical repo records | MVP |
| `repo_snapshots` | Historical metrics over time — required for velocity and decay | MVP (even if ingestion is thin at first) |
| `repo_health_scores` | Computed Health Score with component breakdown, timestamped | MVP |
| `owner_profiles` | Owner tier, signals, domain history | MVP |
| `dependency_maps` | Tracked dependency relationships | Stub if Spike B shows low coverage |
| `search_history` | Past searches with result snapshots | MVP |
| `trend_snapshots` | Weekly captures of rising/fading repos per domain | Future |
| `watch_targets` | Owner and keyword watches | Future |
| `watch_subscriptions` | User to watch-target relationships | Future |
| `notification_events` | Fired alerts with repo, trigger reason, timestamp | Future |

### Stub vs implement decision

For entities marked future: the table must exist in the schema with correct columns.
Do not populate them yet. Do not build logic against them yet.
But they must exist so future phases do not require schema migrations that break existing data.

### Key schema rules

- `repo_snapshots` must have a timestamp column and foreign key to `repositories`. Without this, decay and velocity are impossible.
- `repo_health_scores` must store component-level subscores, not just the total. You need the breakdown for the explanation layer.
- `owner_profiles` must store tier as an enum, not a free string.
- All threshold values (star floors, staleness cutoffs, health score labels) must live in a config file, not hardcoded in schema or application logic.

### Done looks like

- All tables exist in the database
- All future-phase tables exist with correct columns but no data
- Threshold config file exists with all default values
- No application logic has been written yet

---

## Phase 2 — Pipeline Interfaces

Goal: define the typed input/output contract for each stage before implementing any stage.

This takes one day and prevents stages from becoming a tangled monolith.

### Stages and their contracts

| Stage | Input | Output |
|---|---|---|
| Stage 0 — Intent classification | Raw prompt string | `IntentProfile` struct |
| Stage 1 — Broad retrieval | `IntentProfile` | List of raw `RepoCandidate` (150–200) |
| Stage 2 — Hard quality gates | List of `RepoCandidate` | Filtered list (target 30–60) |
| Stage 3 — Prompt-fit scoring | Filtered list + `IntentProfile` | List with `prompt_fit_score` attached |
| Stage 4 — Composite ranking | Scored list | Ranked list with full `RepoScore` |
| Stage 5 — Output filtering | Ranked list | Final `SearchResult` output struct |

### IntentProfile fields

```
artifact_type:      library | framework | cli | tips-content | dataset | boilerplate | tool
domain_speed:       fast | medium | slow
specificity:        narrow | broad
intent_mode:        best_match | best_shortlist | watch
freshness_override: strict | relaxed | none
owner_preference:   company | community | any
confidence:         float (0.0–1.0)
```

### RepoScore fields

```
prompt_fit:          float (0.0–1.0)
health_score:        int (0–100)
health_components:   struct with per-signal subscores
freshness:           float (0.0–1.0)
owner_tier:          elite | strong | promising | weak
decay_label:         healthy | slowing | fading | abandoned
dependency_health:   clean | minor_risk | supply_chain_risk
final_score:         float (weighted composite)
confidence:          high | medium | low
```

### Done looks like

- All stage interfaces defined as types/structs/dataclasses in code
- No implementation logic exists yet — interfaces only
- Each stage can be called with a stub that returns mock data
- Pipeline can be run end-to-end with stubs and produces a typed output

---

## Phase 3 — Hard Quality Gates (Stage 2)

Goal: implement the filtering layer that removes obvious failures before scoring begins.

Build this before broad retrieval. Running gates against your existing MVP data calibrates pool sizes and threshold values before you invest in retrieval breadth.

### Gates in execution order

| Gate | Rule | Stub or implement |
|---|---|---|
| Archived check | Drop if `archived = true` | Implement |
| Fork check | Drop if `fork = true` unless fork has more stars than parent AND independent commits for 6+ months | Implement |
| README existence | Drop if no front-page README unless owner is Elite-tier AND stars exceed threshold | Implement |
| README quality | Drop if README < 300 chars OR keyword overlap with prompt is near zero | Implement (use Spike A results) |
| Domain staleness | Drop if age exceeds domain clock threshold (see domain clock table) | Implement |
| Stars floor | Drop if stars below domain-appropriate minimum AND no credibility signal compensates | Implement |
| Decay disqualifier | Drop if decay label is `abandoned` | Stub (returns `healthy` until Phase 8) |

### Domain clock table

| Domain | Soft penalty | Hard penalty | Disqualify |
|---|---|---|---|
| LLM / Claude / MCP / agents | > 4 months | > 8 months | > 14 months |
| RAG / evals / inference | > 6 months | > 12 months | > 18 months |
| General dev tools | > 18 months | > 3 years | > 5 years |
| Low-level infra / mature libs | > 3 years | > 5 years | Rarely by age alone |

### Pool size targets and fallback rules

- After Stage 2: target 30–60 repos
- If pool > 80: tighten staleness and stars floor thresholds before proceeding
- If pool < 10: widen README quality gate slightly, log a warning that results may be weaker
- Never proceed to Stage 3 with 0 results — surface a "no strong results found" output instead

### Done looks like

- Run gates against 100 repos from your existing MVP data
- Measure how many survive each gate
- Verify pool size lands in 30–60 range for a typical prompt
- Log pool size after Stage 2 for every search run

---

## Phase 4 — Broad Retrieval (Stage 1)

Goal: build retrieval breadth calibrated to feed the gates, not the other way around.

Now that you know how many repos survive Stage 2, you know how wide Stage 1 needs to cast.

### Retrieval approach

- Search by: topic, keyword, README content, description
- Automatically expand to synonyms and adjacent terminology based on `IntentProfile.artifact_type` and `IntentProfile.domain_speed`
- Target 150–200 raw candidates
- Do not rank or filter at this stage — collect only
- Store raw candidates in `search_history` with timestamp

### Retrieval breadth by intent profile

| Specificity | Domain speed | Synonym expansion | Target pool |
|---|---|---|---|
| Narrow | Fast | Moderate | 100–150 |
| Narrow | Slow | Low | 80–120 |
| Broad | Fast | High | 150–200 |
| Broad | Slow | Moderate | 120–180 |

### Done looks like

- Broad retrieval produces 150–200 raw candidates for a typical broad prompt
- Raw candidates are stored in `search_history`
- Stage 2 gates can be run immediately after retrieval and produce a pool of 30–60

---

## Phase 5 — Prompt-Fit Scoring (Stage 3)

Goal: score each candidate against the actual prompt before composite ranking.

Prompt fit is the highest-weight signal. Get it right before adding complexity.

### Scoring components

| Component | Weight | Notes |
|---|---|---|
| Repo name keyword match | 30% | Exact and partial match |
| Description keyword match | 25% | |
| README body keyword match | 20% | Use keyword overlap ratio |
| Topic tag match | 15% | GitHub topics |
| Artifact type match | 10% | library vs CLI vs tips-content etc |

Language match is a hard gate, not a scoring component: if language is specified in the prompt, non-matching repos are dropped before scoring.

### Threshold

Repos scoring below 0.35 normalized prompt-fit are dropped.
After Stage 3: target pool of 10–20 repos.

### Done looks like

- Every surviving repo has a `prompt_fit_score` between 0.0 and 1.0
- Pool is 10–20 repos after threshold drop
- Scores feel intuitively correct when verified manually against 10 test prompts

---

## Phase 6 — Repo Health Score v1

Goal: produce a transparent 0–100 composite score per repo using only signals available now.

Build Health Score with the data you have. Stub the components you don't have yet.
The interface is complete. Implementations fill in over time.

### Components and weights

| Component | Weight | MVP status |
|---|---|---|
| README quality score | 25% | Implement (Spike A) |
| Stars velocity | 25% | Stub (returns neutral until snapshots exist) |
| Dependency freshness | 20% | Stub (returns neutral until Spike B resolved) |
| Maintenance quality | 15% | Implement (commit frequency, release cadence) |
| Owner tier | 15% | Implement (Phase 7) |

### README quality sub-score

| Signal | Weight |
|---|---|
| Length ≥ 300 chars | Gate |
| Keyword overlap with prompt | 30% |
| Has install / setup instructions | 20% |
| Has usage examples or code | 25% |
| README last edit recency (domain-relative) | 25% |

### Health Score labels

| Score | Label |
|---|---|
| 85–100 | Excellent |
| 65–84 | Strong |
| 45–64 | Acceptable |
| 25–44 | Weak |
| 0–24 | Poor |

Repos scoring below 25 are dropped before Stage 4.
Repos scoring below 45 should not appear at rank 1.

### Done looks like

- Every repo in the Stage 3 pool has a Health Score with component breakdown
- Stubbed components return a neutral mid-range value and are flagged as `stub: true` in the score struct
- Scores feel defensible when checked manually against 10 known repos

---

## Phase 7 — Owner Intelligence

Goal: score the account behind the repo, not just the repo itself.

### Owner tier definitions

| Tier | Criteria |
|---|---|
| Elite | Known company or foundation, OR individual with 3+ repos above 5k stars |
| Strong | Multiple repos with 1k+ stars, clear domain relevance |
| Promising | One breakout repo with strong recent signals |
| Weak | Little evidence of sustained output |

### Scoring signals

- Organization vs individual
- Known company / foundation (maintain a lookup list)
- Profile metadata completeness (company field, website, bio)
- Count of repos above 1k, 5k, 10k star thresholds
- Follower count
- Sustained activity across years (not single burst)
- Multiple repos in same domain

### Owner profile storage

Owner profiles are written to `owner_profiles` table.
Tier is stored as an enum.
Profiles are refreshed on a cadence (weekly for active owners, monthly for others).

### Done looks like

- Every repo result has an owner tier attached
- Owner tier feeds correctly into Health Score (15% component)
- Manually verify tier assignment for 20 known owners across Elite through Weak

---

## Phase 8 — Freshness and Decay

Goal: detect stale repos and repos in active decline.

Prerequisite: at least one full snapshot cycle has run and `repo_snapshots` has real delta data.
Do not build decay logic against synthetic or mocked snapshot data.

### Freshness composite (not just last push)

| Signal | Notes |
|---|---|
| Last push date | Weighted by domain clock |
| Last release date | Higher weight than push for repos with release cadence |
| README last modified date | Domain-relative recency |
| Terminology currency | Does README/topics use current domain language? |
| Sustained activity | Commits spread over time vs single burst |
| Stars velocity trend | Growing, flat, or declining |

### Decay signals

- Stars growth rate flatlined or reversed over last 6 months
- Open issues growing, unanswered for 60+ days
- No new releases where release cadence is expected
- Contributor count declining (fewer unique committers last 6 months)
- Critical dependency newly abandoned
- README not updated despite domain terminology shifting
- Forks increasingly diverging from parent

### Decay labels

| Label | Trigger |
|---|---|
| Healthy | No decay signals |
| Slowing | 1–2 soft decay signals |
| Fading | 3+ decay signals — flag prominently |
| Abandoned | No activity past domain threshold + multiple decay signals — disqualify |

### Decay rules for output

- `Fading` repo must never be rank 1 unless there is genuinely no alternative
- If rank 1 is `Fading`, output must flag it explicitly and prominently
- `Abandoned` repos are dropped in Stage 2 gate

### Done looks like

- Every repo has a decay label
- Label changes are detectable across two snapshot periods
- Manually verify labels against 10 repos you know to be declining or healthy

---

## Phase 9 — Dependency Awareness

Goal: detect supply chain risk from abandoned or stale upstream dependencies.

Prerequisite: Spike B resolved and data source confirmed.

### What to check per repo

- Does the dependency list include archived or abandoned repos?
- Are core dependencies still actively maintained?
- Are major dependencies pinned to versions significantly behind current upstream?
- Is the repo itself widely depended on (abandonment risk amplifier)?

### Dependency health labels

| Label | Meaning |
|---|---|
| Clean | All core dependencies healthy |
| Minor risk | One or more dependencies slowing or outdated but not abandoned |
| Supply chain risk | One or more critical dependencies archived or abandoned |

### Health Score integration

Supply chain risk penalizes the dependency freshness component (20% of Health Score).
Clean = full score. Minor risk = partial penalty. Supply chain risk = heavy penalty.

### Output requirement

If supply chain risk is detected, name the specific problematic dependency in the output.
Do not surface a generic warning — name it.

### Done looks like

- Every repo in the final pool has a dependency health label
- Supply chain risk repos have the specific bad dependency named
- Health Score correctly reflects the penalty

---

## Phase 10 — Composite Ranking (Stage 4)

Goal: apply full weighted ranking to the Stage 3 pool.

All signals must exist before this phase. No stubs in final ranking.

### Ranking weights by domain speed

**Fast-moving (LLM, Claude, MCP, agents, evals, RAG):**

| Signal | Weight |
|---|---|
| Prompt fit | 35% |
| Health Score | 25% |
| Freshness composite | 20% |
| Owner tier | 10% |
| Stars absolute | 10% |

**Slower-moving (general tools, mature frameworks, infra):**

| Signal | Weight |
|---|---|
| Prompt fit | 30% |
| Health Score | 25% |
| Stars absolute | 20% |
| Maintenance quality | 10% |
| Owner tier | 10% |
| Freshness composite | 5% |

### Intent signal weight overrides

| Prompt signal | Override |
|---|---|
| "latest", "new", "2025", "current" | Freshness +15%, Stars -10% |
| "stable", "production", "battle-tested" | Freshness -15%, Maintenance +15% |
| Company name in prompt | Owner tier → 50% of score |
| Language specified | Language = hard gate in Stage 3, not weight |
| "beginner", "learn", "tutorial" | README quality +15% |

### Rank 1 rule

Rank 1 must always be the pure best-match result.
Diversity and tradeoff variety apply only to ranks 2–5 in shortlist mode.
Never adjust rank 1 for diversity.

### Confidence scoring

| Condition | Confidence |
|---|---|
| Rank 1 score > 80 AND gap to rank 2 > 10 points | High |
| Rank 1 score 60–80 OR gap to rank 2 < 10 points | Medium |
| Stage 1 pool was thin OR rank 1 score < 60 | Low |

### Done looks like

- Every repo in the final pool has a `final_score`
- Rank 1 is verifiably the best-fit result for 10 test prompts
- Confidence score is attached to every result
- Weight mutations fire correctly for intent override prompts

---

## Phase 11 — Output and Explanation Layer (Stage 5)

Goal: make every result explainable, auditable, and trustworthy.

Build this last. Scores underneath must be trustworthy before the explanation layer is meaningful.

### Required output block per result

```
★ owner/repo-name
  Health: 87 | Decay: Healthy | Confidence: High
  Match: <why this fits the prompt — 1 sentence>
  Freshness: ✅ last release 12 days ago
  Owner: Elite (Anthropic)
  Dependency health: Clean
  Prompt fit: 94%
  Note: <any caveat, risk flag, or decay warning>
```

### Alternatives block (when applicable)

When 1–3 repos have a Health Score within 15 points of rank 1 and offer meaningfully different tradeoffs:

```
  Alternatives worth knowing:
  → owner/repo-b  [Health: 81]  — <one-line tradeoff vs rank 1>
  → owner/repo-c  [Health: 78]  — <one-line tradeoff vs rank 1>
```

### --explain flag

Deep mode showing full scoring breakdown:

```
reposearch "Claude SDK Python" --explain

Scoring breakdown for anthropic/anthropic-sdk-python:
  Prompt fit:          94%
  Health Score:        91
    README quality:    24/25
    Stars velocity:    23/25
    Dep freshness:     18/20
    Maintenance:       13/15
    Owner tier:        13/15
  Freshness:           ✅ (release 12 days ago, README 8 days ago)
  Owner tier:          Elite
  Decay:               Healthy
  Dependency health:   Clean
  Final score:         93.2
  Confidence:          High
```

### --trends flag (Trend Radar)

When `--trends` is passed, append after main result:

```
📡 Trend Radar (last 30 days)
  ↑ Rising:  owner/repo-a  [+340 stars | Health: 82]
  ↑ Rising:  owner/repo-b  [new, 180 stars in 2 weeks | Health: 74]
  → Stable:  owner/repo-c  [consistent activity]
  ↓ Fading:  owner/repo-d  [growth stopped, last commit 3 months ago]
```

Trend Radar uses the Stage 1 pool filtered through Stage 2 only — not the final ranked pool.
Rising repos do not automatically affect rank 1.

### Done looks like

- Every result produces the required output block
- `--explain` produces the full scoring breakdown
- `--trends` appends the radar block
- Fading and supply chain risk flags appear prominently in Note field

---

## Phase 12 — Trend Radar and Search History

Goal: bridge from point-in-time search to ongoing repo awareness.

### Search history

- Store every search in `search_history`: prompt, timestamp, result snapshot
- CLI command `reposearch history` lists past searches
- CLI command `reposearch rerun <id>` re-executes with fresh data and shows what changed
- Store in `~/.reposearch/history.json` locally if no remote persistence yet

### Prompt correction feedback loop

- When the user overrides or rejects a result, log: prompt → result → correction
- Store in local feedback log
- Use for manual classifier tuning initially
- Do not automate feedback incorporation until you have enough data to validate

### Owner graph

- When returning rank 1, automatically check: does this owner have other repos in adjacent domains?
- Surface as: "This owner has N other repos you might care about"
- Pull from `owner_profiles` — no additional API call required if profiles are current

### Done looks like

- `reposearch history` returns last 10 searches
- `reposearch rerun` produces a diff of what changed since last run
- Owner graph surfaces related repos when owner has adjacent domain repos

---

## Phase 13 — Watch and Notifications

Goal: turn trend and quality logic into alerting foundations.

Prerequisite: Phase 12 complete, snapshot cadence stable.

### Watch types

Owner / company watches:
- "notify me when Anthropic publishes a new repo"
- "watch OpenAI repos"

Keyword / category watches:
- "watch Claude repos"
- "watch MCP repos"

### Alert rules

An alert fires only when all of the following are true:
- Repo is from a tracked owner OR matches a tracked keyword/topic
- Repo passes Stage 2 quality floor
- Repo is not a fork
- Repo is not archived
- Repo has a front-page README (Elite-tier owners get partial exemption)
- Repo Health Score ≥ 45

### Done looks like

- Watch targets stored in `watch_targets`
- Alert evaluation runs on new snapshot ingestion
- No alert fires for a repo that fails Stage 2 quality gates
- Notification events stored in `notification_events` with reason and timestamp

---

## Highest Risk Areas (with mitigations)

These are not footnotes. They are schedule risks for a solo developer.

### Risk 1 — Snapshot data dependency

Decay, velocity, and trend logic are all meaningless without historical snapshots.
If you build these features before running real snapshot cycles, you are building on air.

Mitigation: start the snapshot ingestion job in Phase 1 alongside schema creation. Let it run for 2–4 weeks before building Phase 8. Do not shortcut this.

---

### Risk 2 — Dependency mapping coverage

GitHub Dependency Graph API coverage is inconsistent. Many repos do not have it enabled.
Direct file parsing (package.json, requirements.txt etc) adds language-specific complexity.

Mitigation: Spike B resolves this before Phase 9 starts. If coverage is too low, stub the component and ship Phase 9 later. Do not let this block the rest of the pipeline.

---

### Risk 3 — README quality heuristic noise

Naive README scoring can produce counterintuitive results on real data.

Mitigation: Spike A runs before Phase 3. Do not ship the README gate without validating it against at least 30 real repos.

---

### Risk 4 — Intent classification errors

Wrong domain speed classification distorts freshness weights. Wrong artifact type drops valid repos.

Mitigation: Spike C tests against 25 real prompts before weight mutations are committed. Flag low-confidence classifications and surface clarifying questions rather than proceeding silently.

---

### Risk 5 — Thin result pools

Aggressive gates can produce empty or near-empty pools for niche prompts.

Mitigation: Stage 2 must log pool size after every gate. Build fallback rules explicitly (widen README gate if pool < 10). Never return 0 results silently — surface a "no strong results found" output with the reason.

---

## Stub vs Implement Decision Table

This table defines what gets real implementation in MVP vs a neutral stub.
Stubs must return a neutral mid-range value and must be flagged as `stub: true` in the score struct.

| Feature | MVP status | Stub behavior |
|---|---|---|
| Hard quality gates | Implement | — |
| Prompt-fit scoring | Implement | — |
| README quality score | Implement | — |
| Maintenance quality score | Implement | — |
| Owner tier scoring | Implement | — |
| Domain clock / freshness | Implement | — |
| Stars velocity | Stub | Returns 0.5 neutral |
| Decay detection | Stub (implement after snapshots) | Returns `healthy` |
| Dependency health | Stub (implement after Spike B) | Returns `clean` |
| Trend radar | Implement (uses Stage 1 + 2 data) | — |
| Watch / notifications | Future | — |
| Classifier feedback loop | Future | — |
| Cross-repo dependency graph | Future | — |

---

## Milestone Summary

### Milestone 1 — Pipeline Foundation
Phases 1–5 complete. Spikes A, B, C done.
Result: staged pipeline running, hard gates filtering, prompt-fit scoring working.
Success check: rank 1 is meaningfully better than current MVP output for 10 test prompts.

### Milestone 2 — Intelligence Layer
Phases 6–7 complete.
Result: Health Score and owner tier attached to every result. Explanation output v1 shipped.
Success check: results are explainable. Stale but famous repos stop dominating rank 1.

### Milestone 3 — Freshness and Decay
Phase 8 complete (requires snapshot data to exist from Phase 1 ingestion job).
Result: decay labels on all results. Stars velocity contributing to Health Score.
Success check: system correctly labels 10 known declining repos as Fading or Abandoned.

### Milestone 4 — Full Composite and Output
Phases 9–11 complete.
Result: full composite ranking, dependency health, --explain and --trends flags live.
Success check: output is auditable, confidence scores are accurate, alternatives block appears when relevant.

### Milestone 5 — Radar Foundation
Phases 12–13 complete.
Result: search history, rerun, owner graph, watch targets, notification events.
Success check: product begins moving from point-in-time search to continuous repo awareness.

---

## Immediate First Week

Day 1: Run Spike A (README scoring), Spike B (dependency data source), Spike C (intent classification).
Day 2: Design and ship full schema. Start snapshot ingestion job running.
Day 3: Define all pipeline interfaces as types. Run pipeline end-to-end with stubs.
Day 4: Implement Stage 2 hard quality gates. Run against 100 repos from current MVP data. Measure pool sizes.
Day 5: Implement Stage 1 broad retrieval calibrated to feed Stage 2. Verify 150–200 candidates → 30–60 after gates.

After week 1: schema exists, ingestion is running, pipeline skeleton is typed, gates are live.
Everything from Phase 5 onward is building on a solid foundation.
