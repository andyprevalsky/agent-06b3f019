---
id: 2026-10-25-demo-replay-worker-cpu-starvation-normalization-and-live-jev
date: 2026-10-25
title: Mass-agent DEMO replay saturated the single cloud worker, so post_agent_message expired before its request left the worker
surface: agents
component: demo-cache-normalization-and-jev-progress
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: the guest's single Temporal worker process (BENCHMARK_AGENT_WORKERS=1 on a 2-CPU performance-2x fan-out primary) ran at its one-core ceiling during the 50-GP fan-out; 21% of its CPU re-normalized every message of every history per replayed call (providers/demo_cache/normalize.py _normalize_volatile_text, O(turns^2)) and 15% built per-turn JEV snapshots for live api.typesafe.ai calls (helpers/jev_progress.py) inside a zero-live DEMO replay
symptoms:
  - "Observed tool failure: 063cc3fb:spawn_agent toolu_01Fsd6E8xXw8Sf6rkiLkgrFH status=ERROR"
  - "Tool spawn_agent failed: activity StartToClose timeout"
  - "Completing activity as failed ({'activity_id': '32', 'activity_type': 'post_agent_message'"
  - "Declared evaluator t10-no-tool-failures failed"
tags:
  - mass-agent
  - demo-cache
  - cpu-starvation
  - temporal-activity-timeout
  - jev-progress
  - performance
sources:
  - agent 107932cb-8df3-45ac-9042-93ad9c444c90
  - fleet run 20261025-131942-4154038
  - commit c3ffc0092
  - memory:mass-agent-stall-pins-worker-drain
repro: agents/tests/blackbox/demo_cache_client.blackbox.py::test_history_normalization_runs_once_per_distinct_message; agents/tests/blackbox/jev_progress.blackbox.py::test_demo_replay_runs_without_jev
status: mitigated
---

## Problem

Cloud run 2 of test-mass-agent-run-0 on 54ab17c12 failed t10-no-tool-failures. GP 063cc3fb's
spawn_agent card showed "Tool spawn_agent failed: activity StartToClose timeout" at 13:40:50Z.
The same toolCallId later showed FINISHED. Outputs (50/50) and T7 passed.

## Diagnosis

The explore itself succeeded: `explore_activity_wait` ended OK after 20.8s at 13:39:16. The
GP's next activity, `post_agent_message` (id 32, posting the tool result), was cancelled on
timeout three times, 13:39:16→13:40:50. None of those requests reached the backend (no
request from 063cc3fb until 13:40:56). In that window the backend served 14,697 requests at
225 ms average, with one over 5s.

Guest diagnostics: 2 CPUs at 90–98% busy for about 7 minutes. The Python worker
(`BENCHMARK_AGENT_WORKERS=1`) sat at about 80% of a core, which is its GIL ceiling, and node
used about 65%. Across the run there were 211 `post_agent_message`, 165
`fetch_child_terminal_result` and 32 `fetch_agent_config` activity timeouts. The autoscaler
clone joined the queue at 13:42:20, after the burst, while the GP workflows were sticky to the
primary.

py-spy on a single local worker during the fan-out:
- `llm_keys` → `canonical_messages` → `_normalize_volatile_text`: 21–23% inclusive. Every
  replayed call re-ran about 45 regex passes over every message of its history.
- `predict_jev_progress`: 15%. A per-turn JSON snapshot of the full history, plus a live
  `api.typesafe.ai` request, in a task whose contract is zero live calls.

## Solution

- `_normalize_volatile_text` is memoized (a bounded LRU of 4096). It is pure in its text,
  and keys are byte-identical.
- `with_jev_session` gives a DEMO replay (`fast_mode_cache_enabled`) no JEV session, so there
  is no live estimate and no per-turn snapshot. Live runs are unchanged.
- No timeout, retry budget, check or card was changed.

Local measurement, identical conditions (1 worker, whole stack capped at `CPUQuota=200%`):

| | Base 54ab17c12 | Fixed c3ffc0092 |
|---|---|---|
| Stack CPU-seconds | 795.6 | 604.0 (−24%) |
| Wall time | 531 s | 434 s (−18%) |

Both runs had 0 failed activities and passed 19/19, with all 3,485 calls served from cache.
Local capped cores did not reproduce the guest timeouts, so the cloud outcome is pending.
Status is mitigated until the cloud runs confirm.

Golden reference: a cache key should be derived once per request, not recomputed per prefix
(claude-code-src/src/services/vcr.ts:88 hashes the dehydrated input once per call).

10k agents: per-worker CPU per replayed call drops; the cache is bounded at 4096 entries.

Remaining option (infra, not applied): a larger fan-out primary (`CLOUDBENCH_FLEET_FANOUT_VM_SIZE`,
currently performance-2x), or more guest workers for fan-out tasks, if the cloud still starves.

## Human feedback

Parent constraints: no timeout raises (rule 25), don't hide a real ERROR card, hold at 10k
agents (rule 28); worker scaling or guest sizing counts as infra.

## Reusable lesson

When small activities time out without reaching the backend, profile the worker before touching timeouts; per-call recomputation over growing histories and background live calls in replay mode starve a single event loop.
