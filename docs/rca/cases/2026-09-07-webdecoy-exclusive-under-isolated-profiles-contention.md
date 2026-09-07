---
id: 2026-09-07-webdecoy-exclusive-under-isolated-profiles-contention
date: 2026-09-07
title: Isolated-profile scheduler dropped webdecoy from exclusive phase so concurrency=2 LLM contention poisoned FCaptcha
surface: harness
component: agents/benchmarks/run_benchmark.py _parallel_task_phases
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "agents/benchmarks/run_benchmark.py _parallel_task_phases — discarded BIOMETRICS_WEBDECOY from EXCLUSIVE_SHARED_DB_TASK_NAMES when BENCHMARK_ISOLATED_BROWSER_PROFILES=true and no auth-reading siblings"
symptoms:
  - "Timeout after 423s (dynamic cap=420s) | Agent status: PAUSED (expected COMPLETED)"
  - "PoW verification failed: challenge_network_mismatch"
  - "Click injected with no pointer trajectory"
  - "pow_not_satisfied"
  - "Running 6 tasks in parallel (max_concurrency=2)"
tags:
  - browser-biometrics-webdecoy
  - fcaptcha
  - concurrency
  - predeploy
  - exclusive-phase
sources:
  - agent 76feb17f-5601-45f6-8245-6e6b543c7a7e
repro: agents/tests/blackbox/benchmark.blackbox.py::test_biometrics_fixture_stays_exclusive_under_isolated_profiles
status: fixed
---

## Problem

Pre-deploy smoke task `browser-biometrics-webdecoy` passed in ~204s on the first
attempt in the same deploy session, then timed out at 423s (dynamic cap 420s)
on the second attempt with agent status PAUSED. Agent
`76feb17f-5601-45f6-8245-6e6b543c7a7e` spent 424s inside
`spawn_browser_agent_activity_v3` / `browser_activity_wait`, never reached
COMPLETED, and ended with progress_score 0.005.

Network capture of the first checkbox `/api/verify` returned:

```json
{"success":false,"reason":"pow_not_satisfied","detections":[
  {"reason":"PoW verification failed: challenge_network_mismatch"},
  {"reason":"Click injected with no pointer trajectory (1 teleport clicks)"},
  {"reason":"Unusually long interaction time"}
]}
```

The agent then retried checkbox clicks until the harness paused it. The same
task in the earlier pass run verified successfully at ~37s
(`success:true`, score 0.0624) with a direct checkbox click.

## Diagnosis

Critical path:

`predeploy concurrency=2 → _parallel_task_phases discards webdecoy exclusive →
webdecoy overlaps parallel-tool-calls → browser LLM IDLE gaps (up to 53s) →
first FCaptcha verify at ~176s → challenge_network_mismatch + teleport →
retry loop until 420s timeout`

Evidence:

1. Fail schedule started webdecoy and `parallel-tool-calls` at the same second
   (`02:40:10`). Predeploy log: `Running 6 tasks in parallel (max_concurrency=2)`.
2. Latency tree for the fail agent showed many IDLE gaps inside
   `browser_activity_wait`, including a 53s stall, while parallel-tool-calls was
   fanning explore-agent LLM calls.
3. Pass run clicked the checkbox ~33s after start; fail run's first verify was
   at request_ts_ms=176727 (~3 min of exploratory scrolls/drags under load).
4. `_parallel_task_phases` intentionally discarded webdecoy from
   `EXCLUSIVE_SHARED_DB_TASK_NAMES` when `BENCHMARK_ISOLATED_BROWSER_PROFILES`
   was on and no auth-reading siblings existed. Local/`run-bench --local`
   always sets that env flag, so smoke always parallelized webdecoy with
   LLM-heavy siblings. Isolation protects cookie/DB state, not CPU/LLM timing
   that FCaptcha PoW + pointer trajectory depend on.

Archive searches:

- `browser-biometrics-webdecoy timeout PAUSED` → relative cases on wait-loop /
  step-budget / drag (different first-bad boundaries).
- `challenge_network_mismatch pow` → relative
  `2026-09-04-browser-recovery-stale-keyword-crashed-provider-rotation` (same
  FCaptcha 0.1463 PoW/teleport/long-interaction signature after a later
  fingerprint-poison path; recovery-contract bug, not scheduler).
- `Click injected with no pointer trajectory` → no prior exclusive-scheduler hit.

This incident is a **relative** of the known FCaptcha PoW/teleport rejection
signature, novel at the scheduler boundary that *creates* the long-interaction
precondition under local predeploy concurrency.

## Solution

Always keep `browser-biometrics-webdecoy` in the exclusive phase — remove the
isolated-profile discard in `_parallel_task_phases`. Isolated profiles still
allow other browser tasks to overlap each other via
`_parallel_task_runners`; only webdecoy is forced alone so it cannot share the
concurrency=2 slot with `parallel-tool-calls`.

Cemented by
`test_biometrics_fixture_stays_exclusive_under_isolated_profiles` (replaces the
old "joins parallel batch" expectation). Pre-fix: old discard logic empties
exclusive for a smoke-like set; post-fix: webdecoy is the sole exclusive task.

10k-agent behavior: one additional serial slot only for this single biometrics
smoke task in multi-task batches; no per-agent fan-in, no shared lock growth
with agent count.


Post-fix solo outcome (`bash scripts/run-bench --local browser-biometrics-webdecoy`,
agent `956ae08f-8e09-4f89-a97e-471bb2b0a0af`): checkbox `/api/verify` succeeded
(`success:true`, score 0) — the original contention→checkbox-poison class did not
recur. The run still timed out after invisible-mode `form_submit` returned
`pow_not_satisfied` and the agent burned remaining budget on network/log/evaluate
waits. That residual is a separate first-bad boundary from the exclusive-phase
discard fixed here.

## Human feedback

None recorded. Deploy RCA requested investigation of the timeout and preferred
a harness contention fix over raising the timeout (rule 25).

## Reusable lesson

Browser-state isolation does not buy biometrics timing isolation — keep
FCaptcha/webdecoy exclusive of concurrent LLM-heavy siblings even when profiles
are isolated.
