---
id: 2026-07-11-completion-gated-behind-final-summary-message-post
date: 2026-07-11
title: Agents were marked finished only after the non-critical completion_summary message insert, so a slow insert left verified agents durably ACTIVE
surface: agents
component: temporal-workflow
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py — completion persistence ran after the final `completion_summary` message post instead of before it
symptoms:
  - "Agent status: ACTIVE (expected COMPLETED)"
  - "Agent status: COST_LIMIT_REACHED (expected COMPLETED)"
  - benchmark run record reports cost_cents 0 for a run that tripped its price cap
  - already-verified agent stays durably ACTIVE until the smoke or benchmark timeout
  - smoke tasks `message-person` and `spawn-sub-agents` fail on timeout
tags:
  - temporal
  - workflow
  - agent-status
  - completion-summary
  - smoke
  - ordering
  - cost-limit
  - recurrence
  - benchmark
sources:
  - PR #739
  - commit c22ea686c
  - commit 105733b93
  - agent f79ad255-85a0-4254-9913-152dceba3381
  - agent a67ef234-e1d8-4e72-adda-020cdcab6059
repro: agents/tests/blackbox/workflow.blackbox.py
status: fixed
---

## Problem

Two smoke tasks — `message-person` and `spawn-sub-agents` — failed on timeout
even though both agents had already been verified as done. Their rows stayed
`ACTIVE` in the database for the whole remaining smoke budget, so the harness
kept waiting on agents that had finished their actual work.

## Diagnosis

Both failures shared one cause: `agents/workflows/agent_workflow.py` only marked
an agent finished _after_ posting the final `completion_summary` message. That
message is a UI nicety, not part of the completion contract, but it sat on the
critical path — so any slowness in inserting it (or any failure of that insert)
left an already-verified agent durably `ACTIVE`. The deeper flaw is ordering: a
non-critical presentation write was allowed to gate the authoritative lifecycle
transition that every consumer (smoke harness, frontend, parent agents) polls.

## Solution

Persist agent completion _before_ the non-critical final summary UI post, so the
authoritative status transition can never be delayed or lost by a presentation
write. Landed in `agents/workflows/agent_workflow.py` and cemented by a workflow
ordering regression in `agents/tests/blackbox/workflow.blackbox.py`, which runs
in the agents blackbox suite. The same ordering rule protects every other
lifecycle consumer, not just smoke: any observer that waits on terminal status
now sees it as soon as the work is verified.

## Recurrence 2026-08-04 — boundary excluded by evidence; two latent defects fixed

Benchmark `browser-bing-search-single-result` (descend slice `antibot`, epochs
2-3) failed twice with correct child output. The `/descend` controller carried a
standing hypothesis that the root's post-child completion transition was the
cause. **The evidence excludes it.** Both first-bad boundaries are in the
browser child.

Agent `f79ad255-85a0-4254-9913-152dceba3381` — the completion path ran, and
succeeded. Timeline from `run.json` (`logs.messages` + `logs.realtime_logs`;
run started `23:31:36.806Z`, cap 300s):

| time | event |
| --- | --- |
| `23:36:34.153Z` | browser child returns the correct result (T+297.4s) |
| `23:36:46.235Z` | root calls `attempt_completion` |
| `23:36:48.961Z` | verifier `⚖️ Progress: 100%` (T+312.2s) |
| `23:36:51.672Z` | `completion_summary` IN_PROGRESS posted |
| `23:36:55.838Z` | `UPDATE {treeCostCents: 36}` |

That last persist is decisive: inside `_mark_complete` the only emitter after
the IN_PROGRESS post is `_track_llm_cost` -> `_update_cost_and_signal_parent` ->
`_persist_tree_cost`, which runs **after** `generate_completion_summary`
returns. So the summary activity completed in ~4.2s — it did not stall, did not
exhaust its retries, and nothing was discarded. `ACTIVE` is the last status the
harness *observed*, not the workflow's outcome. The full verdict is
`Timeout after 306s (dynamic cap=300s) | ... | Agent status: ACTIVE (expected
COMPLETED)`; `run_benchmark.py` checks `elapsed > resolved_timeout` at the top of
its poll loop, before fetching status, so the run was already declared timed out
before the verifier even scored. **First-bad boundary: the browser child
consumed 289 of the 300-second budget cycling click/wait/screenshot against a
recurring Bing/Cloudflare verification wall** — the root had ~11s of budget left
and used 14.8s to reach a verified completion.

Agent `a67ef234-e1d8-4e72-adda-020cdcab6059` — the cost limit fired
legitimately, on a live root. The transcript has **no `attempt_completion`, no
verifier and no `completion_summary`** (`progress_score: 0`,
`llm_call_count: 1`), so `_is_finished` was `False`. At `00:13:54.661Z` the
browser tool result relayed its usage:

```json
{"model": null, "provider": "Rose 1 Browser Use", "tokens_in": 194268,
 "tokens_out": 2187, "cache_read_input_tokens": 0,
 "cache_creation_input_tokens": 0}
```

194k input tokens with **zero prompt-cache reuse** and `model: null` (so
`_track_usage` prices them at the root's pool rate) crossed the 50c cap on the
very next `_update_cost_and_signal_parent`; the `COST_LIMIT_REACHED` UPDATE
landed 2.65s later at `00:13:57.313Z`. **First-bad boundary: browser-agent token
consumption — a 14-step Bing search costing 194k uncached input tokens against a
50c cap.**

### Why this took three epochs to settle: the run record could not be reconciled

`backend_logs` = "[render] 0 logs for agent" and `worker_logs` = "[fly.io] 0
logs" — the `💰 Cost limit exceeded` worker line was already gone. Worse, the
run record reported `cost_cents: 0` for a run that tripped a 50c cap, because
`_check_cost_limit` never flushed the tree cost: `_update_cost_and_signal_parent`
debounces its persist to one emit per 3s, and the agent pauses immediately after
the trip, so the stale pre-trip `0` stayed the last number written to the agent
row, the FE cost display and `stop_metadata`. Two mutually exclusive numbers in
the same record (`cost 0c` vs `cap 50c`) are what kept sending this RCA back to
the root boundary. This is the observability defect that mattered, and it is
fixed.

### Latent defects found at the excluded boundary (fixed, not causal)

Neither of these caused either run, and both are real:

1. `_check_cost_limit` had no `_is_finished` guard. `_mark_complete` latches
   `_is_finished` first and then tracks the completion summary's own LLM cost
   (`_track_llm_cost` -> `_update_cost_and_signal_parent` -> `_check_cost_limit`);
   a sub-agent's final `child_cost_update` signal lands on the identical path.
   Either could write `COST_LIMIT_REACHED` over a verifier-100% root and cascade
   a spurious pause to its children. `COST_LIMIT_REACHED` is terminal for every
   poller, so a flicker is enough to record a completed run as failed. The
   workflow's own comment above the cost recalc named this hazard and worked
   around it at that one call site instead of enforcing it in the checker.
2. `generate_completion_summary` sat inside the same `try` whose `except`
   re-raises, so a summary LLM failure aborted the durable terminal transition of
   an already-verified agent — the *failure* half of the 2026-07-11 diagnosis
   ("any slowness in inserting it, **or any failure**"), which `105733b93`
   reintroduced.

Why the original guardrail did not hold: the 2026-07-11 fix (`c22ea686c`) was
cemented as an **activity-ordering** assertion
(`mark_finished_index < final_summary_index`). On 2026-07-22, `105733b93`
inverted both the code and that assertion to satisfy a different valid
requirement — pollers treat COMPLETED as a safe point to read the transcript, so
COMPLETED must imply the summary row is observable. Because the guardrail
encoded an *order* rather than the *invariant*, it could be flipped without ever
failing.

### Fix (2026-08-04)

- `_check_cost_limit` returns early when `_is_finished` is latched. The limit
  authorizes future spend and a finished agent has none, so the invariant lives
  in the checker rather than at one caller, and a finished root can no longer
  cascade a pause to its children.
- `_check_cost_limit` force-persists the tree cost before writing the terminal
  status, so a cost-limited run stops reporting `0c` to every consumer.
- The `COST_LIMIT_REACHED` status message carries its decision inputs
  (`subtree >= limit (own + children)`) so the reason survives into the agent
  row and the run record when worker logs are gone.
- `generate_completion_summary` is wrapped in its own `try/except`: the failure
  is logged, surfaced on the final message as
  `completionSummary.summaryError`, and the summary degrades to a goal
  restatement (the shape `helpers/child_results.py:_best_effort_text` already
  uses) so the root completion SMS — gated on `summary` being truthy — and the
  parent's `child_completed` handoff are not silently dropped. The durable
  transition always runs. The 2026-07-22 requirement is preserved: the FINISHED
  summary row is still posted before the terminal status.

### Known residual (not fixed here)

The declared invariant is not fully implemented. Between the verifier and
`mark_finished` there still sit two `post_agent_message` activities, the summary
LLM activity, and the usage/cost writes — worst case several minutes of
non-critical work ahead of the durable terminal write. The try/except removes
the *abort*, not the *latency*. Fully removing it means writing the terminal
status and the summary row atomically (one backend call) so the 2026-07-11 and
2026-07-22 requirements stop trading off; that is a backend change and is filed,
not done. It was not causal for either run above.

10k-agent behavior of these changes: strictly less work per agent — one fewer
status write and no child-cascade signals in the completion window, one extra
already-debounced cost persist that only fires on the terminal cost-limit
transition, and no new channels, subscriptions, or per-agent polling. The
`_is_finished` guard does mean a root stops enforcing the cap on still-running
children for the duration of `_mark_complete`; the root workflow exits shortly
after and orphaned children abort via `_check_parent_state`, so the residual
window is bounded by the completion path rather than by agent count.

Cemented by five regressions in `agents/tests/blackbox/workflow.blackbox.py`,
all failing with only `agents/workflows/agent_workflow.py` reverted to the
pre-fix revision and passing after it: `wf_check_cost_limit_after_finished`,
`wf_cost_limit_flushes_tree_cost`, `wf_mark_complete_survives_summary_failure`,
`wf_mark_complete_summary_cost_no_cost_limit`,
`wf_mark_complete_degraded_summary_keeps_notification`.

**This fix does not make `browser-bing-search-single-result` pass.** Its two
proven first-bad boundaries — the browser child's 289s wall-clock and its 194k
uncached input tokens against a 50c cap — are unaddressed here and are the
remaining work.

## Human feedback

None recorded for 2026-07-11.

2026-08-04 recurrence: the human withdrew an earlier proposed global
browser-agent system-prompt rule for this benchmark (removed at commit
`2f36ab944`) and instructed that it must not be re-proposed. The `/descend`
outcome gate for this task also required that no production fix or benchmark
rerun be proposed until the post-child root completion boundary had a hard
proof pair — which is why this recurrence ships a boundary repro rather than a
benchmark rerun.

## Reusable lesson

Never gate an authoritative lifecycle state transition behind a non-critical
presentation write, and cement the invariant ("no presentation work may delay or
abort a verified terminal transition") rather than the current activity order —
an ordering assertion can be flipped without ever failing. When a run record
carries two mutually exclusive numbers (cost 0c against a tripped 50c cap),
force-flush the debounced value at the transition before blaming any downstream
boundary.
