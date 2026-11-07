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
  - "Observed tool failure: 4ec67f04:spawn_agent toolu_017WjLfYYfJsJW41EL4GJ68H status=ERROR"
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
  - agent 4ec67f04-ad1d-40dc-a1bf-123d1c6a7293
  - fleet run 20261107-094051-1912080
  - commit d18703e43
repro: agents/tests/blackbox/demo_cache_client.blackbox.py::test_history_normalization_runs_once_per_distinct_message; agents/tests/blackbox/jev_progress.blackbox.py::test_demo_replay_runs_without_jev; agents/tests/blackbox/llm.blackbox.py::test_repeated_history_render_redacts_and_projects_each_input_once; agents/tests/blackbox/llm.blackbox.py::test_per_turn_compute_lease_calls_reuse_the_pooled_client
status: mitigated
---

## Problem

Cloud run 2 of test-mass-agent-run-0 on 54ab17c12 failed t10-no-tool-failures. GP 063cc3fb's
spawn_agent card showed "Tool spawn_agent failed: activity StartToClose timeout" at 13:40:50Z.
The same toolCallId later showed FINISHED. Outputs (50/50) and T7 passed.

### Recurrence 2026-11-07

The PR #1752 deploy smoke (source db7cce8d2, fleet run 20261107-094051-1912080) failed
t10-no-tool-failures with "Observed tool failure: 4ec67f04:spawn_agent
toolu_017WjLfYYfJsJW41EL4GJ68H status=ERROR". The same task had passed twice earlier that day on
nearly the same source.

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

### Recurrence 2026-11-07

This is the same chain. Temporal history for workflow 4ec67f04 shows `spawn_explore_agent_activity`
(id 49) completed at 10:05:52.0, and its result post `post_agent_message` (id 50) was scheduled at
10:05:52.5.

- **Attempt 1** failed with `httpx.ReadError('')` at 10:05:58.6, 6 s later. A second agent's post
  failed the same way in the same millisecond. A reused keep-alive socket racing the backend's
  close is inferred, not shown: Node and httpx both default to a 5 s keep-alive.
- **Attempts 2 and 3** each hit StartToClose (30 s). Attempt 3 started at 10:06:31.6 and timed out
  at 10:07:01.6 with MAXIMUM_ATTEMPTS_REACHED.
- **The backend never saw them.** It logged no POST from 4ec67f04 in that window, and no non-INFO
  lines or event-loop stall. The worker never logged "Failed to post message" or an httpx timeout
  for them either. Both coroutines finished only at 10:08:38.9, as `CancelledError`, in a burst
  with dozens of other activities.
- The run_agent tool executor turned the exception into the ERROR card.

Guest diagnostics show the single Python worker at 85–95% of one core from 10:00:39 to 10:09:28.
Root-history `post_agent_message` (about 50 ms on the backend) ran with a p50 of 2.7 s, a p90 of
10 s and a max of 26 s. 74 `fetch_child_terminal_result_activity` attempts timed out, and their
GETs reached the backend up to 22 s after the server started them.

**Mechanism (measured).** Temporal marks an attempt started when the worker's poller takes it.
Up to `MAX_CONCURRENT_ACTIVITIES` (100 on the guest) attempts can be started at once, but the body
only runs when the saturated event loop reaches it. The new `activity.dispatch_lag` log
(`helpers/activity_dispatch.py`, a worker interceptor) records that gap. Two arms ran concurrently
under identical conditions: the whole stack capped at `CPUQuota=100%`, one worker and the guest's
worker settings (100 activity slots, 8 pollers, 50 workflows), using
`scripts/run-bench --local test-mass-agent-run-0` on an unchanged task:

| | Buggy 818f3669f + interceptor | Fixed d18703e43 + interceptor |
|---|---|---|
| Outcome | FAIL: Timeout after 902s, root ACTIVE | PASS in 632 s |
| Bodies started ≥5 s late (at about 11 min) | 811, lag p50 23.6 s / p90 31.4 s / max 39.2 s | 136, lag p50 8.4 s / p90 15.4 s / max 23.8 s |
| Activity timeouts (whole run) | 331 | 3 |
| FE | agent 23492d9d-8164-4245-b383-e26f8d70a87e | agent 5dbe4c05-b1ff-44c8-ad29-ed9835f69947 |

Attempts whose body starts more than 30 s after the server started them time out without issuing
a request. That is exactly what attempts 2 and 3 show.

With 16 slots (the default for a non-cloud local benchmark) the same pair passed with no dispatch
lag, because unstarted work waits on the server. A local run that does not pin the guest's slot
count therefore cannot reproduce this failure.

An earlier single pair at 500 slots gave the same direction: the buggy arm hit Timeout after 905s
with 3 `Tool spawn_agent failed: activity StartToClose timeout`. The fixed arm passed in 627 s.
At `CPUQuota=130%` and uncapped, the buggy revision passed.

**Where the loop's CPU went.** py-spy sampled the worker at 40 Hz during an uncapped, passing local
run of the unchanged task on 818f3669f: 13,392 samples, plus 2,381 sampling errors. The
percentages below are of successful samples across all threads, inclusive. The hotspots barely
overlap. Each one re-ran on every turn of every explore (O(turns^2)):

- **`attachment_request_overhead`: 16.5%.** Every turn it rebuilt both provider schema projections
  (`model_json_schema`, `_inline_refs`) of the compiled AgentAction class, only to measure their
  size. Added 2026-10-22 (495a60153).
- **`redact_sensitive_text`: 13.8%.** Of this, 9.6% came from `_render_llm_messages.bounded_tool_text`
  → `preview_tool_text` re-redacting every earlier tool result on every render. Another 2.0% was
  thread-pool redaction of texts over 100 KB, which the memo below does not cover. Added to the
  per-turn path on 2026-10-26 (db9ea2314).
- **`ssl.create_default_context`: 8.4%.** 5.5% of it was `fetch_compute_token_activity` building a
  fresh `httpx.AsyncClient` for the per-turn flash explore lease, added 2026-10-29 (1318577b7).

The 10-25 fix removed two named hotspots and regressed only those functions. Nothing bounded the
remaining per-turn work, so later features added new O(turns^2) costs and used up the headroom.

**Cloud outcome.** The original failing command was rerun unchanged at d18703e43 (campaign
20261107-113655-607889): 9/9 PASS, 0 infra. test-mass-agent-run-0 passed t10 in 403.6 s with 0
activity timeouts, 0 post failures and 0 spawn_agent failures. Its worker's median CPU was 81%;
the failing run's was about 88%.

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

### Recurrence 2026-11-07 (commit d18703e43)

- `redact_sensitive_text` memoizes texts of 16,384 chars or fewer in a 4,096-entry `lru_cache`.
  It is pure in (text, trusted_placeholders), and about 96% of tool-result chars in this task fall
  under the size bound. Larger texts are redacted uncached, which bounds worker memory.
- `attachment_request_overhead` derives the two schema projections once per compiled model class
  (`lru_cache`, 256 entries). Callers only measure them.
- `fetch_compute_token_activity` and `heartbeat_compute_token_lineage_activity` use the pooled
  `get_http_client()`, with unchanged per-request timeouts.
- Regressions in `agents/tests/blackbox/llm.blackbox.py`. Both failed on 818f3669f ("4 re-renders
  of a seen history repeated work: {'extra redaction pattern passes': 24, 'extra schema builds for
  one compiled model class': 16}"; "6 per-call AsyncClient(s) built for 6 per-turn lease calls")
  and pass on the fix:
  - `test_repeated_history_render_redacts_and_projects_each_input_once` asserts that a seen
    history is never re-redacted or re-projected and that output stays redacted.
  - `test_per_turn_compute_lease_calls_reuse_the_pooled_client`
- `helpers/activity_dispatch.py` adds a worker interceptor that logs `activity.dispatch_lag` when an
  attempt's body starts at least 5 s after Temporal started it. A future timeout whose body never
  ran is then attributed to the worker, not the callee. Tests are in `worker.blackbox.py`:
  `test_late_activity_body_start_is_logged_with_its_dispatch_lag` and
  `test_worker_registers_activity_dispatch_lag_interceptor`.
- No timeout, retry budget, evaluator, task or card changed. The keep-alive race cost only attempt
  1, which is retryable. Starvation is what blocked attempts 2 and 3, so the client keep-alive
  setting is unchanged. Residual risk: the lease GET now shares pooled sockets and still maps any
  error to "no token". This matches every other pooled backend call. In production the worker
  reaches the backend through Render's proxy, not a bare 5 s Node socket.

Golden reference: not applicable (no approval-gated hunk).

10k agents: per-turn worker CPU drops for every agent. Both caches are per worker process and
bounded. The redaction memo is at most 4,096 entries of 16,384 chars or fewer, holding key and
value. An unchanged value is the same object as its key, and keys are usually already held by
live histories. Worst case is about 128 MB of 1-byte text. Measured worker peak RSS was 531 MB
fixed vs 472 MB buggy, and the buggy arm had not finished its work. The schema cache is at most
256 classes.

Status remains mitigated. One worker per 2-CPU guest is still the fan-out ceiling, and nothing yet
bounds per-turn CPU in general: each regression guards a named recomputation. The
`activity.dispatch_lag` warning is the early signal. The infra option above stays open if the cloud
starves again.

## Human feedback

Parent constraints: no timeout raises (rule 25), don't hide a real ERROR card, hold at 10k
agents (rule 28); worker scaling or guest sizing counts as infra.

## Reusable lesson

When small activities time out without reaching the backend, profile the worker before touching timeouts; per-call recomputation over growing histories and background live calls in replay mode starve a single event loop.

### Recurrence 2026-11-07 (PR #1751 smoke, source 9c6d9c3622)

`test-mass-agent-run-0` failed `t10-no-tool-failures` again in the cloud smoke of PR #1751 (fleet run
20261107-120351-779225, agent 27dba2f8-e372-4882-904e-80fe7451d4c8): "Observed tool failure:
b7261a30:attempt_completion 38d78546-4be3-4c73-8fec-4af69183b30b status=ERROR". The same task passed in the
smokes at f8c0511b0d (697 s) and 826c8cf8b8 (724.5 s), and `git diff --stat 826c8cf8b8 9c6d9c3622` touches only
deploy documentation and the failure-report helper, so no runtime file differs. The failing agent paths are
byte-identical on origin/main. RCA verdict `NOT_INTRODUCED`.

First-bad boundary on the guest primary worker: the `post_agent_message` activity that posts the
"Running verifier" chip of `attempt_completion` (30 s StartToClose, three attempts, `handle_tool_event.py:90-98`)
hit `httpx.ReadError('')` at 12:16:34.5 (worker.log:103817-103818); attempts 2 and 3 hit StartToClose
(worker.log:116394), producing two ERROR chips at 12:17:41.5 and 12:17:52.7. The model re-issued
`attempt_completion` at 12:18:19 and finished at 12:18:35.5, so the run recovered. Evaluator t10 counts every
ERROR tool row outside a closed list of recoverable patterns (`run_benchmark.py::_tool_runtime_failures`), and
`attempt_completion` is not on that list; the evaluator was not changed. Other worker-to-backend calls were served
in 19-953 ms while the two attempts were stuck, so the worker was not globally wedged. The backend first logged the
two stuck POSTs 1.2 s after the worker logged both attempts cancelled, and cancellation reached the worker 55-87 s
after StartToClose although heartbeat throttling is 15 s, so the attempt bodies probably started or heartbeated
minutes late (unproven).

Local reproduction: not reproduced. `bash scripts/run-bench --local test-mass-agent-run-0` on the exact unchanged
task under `CPUQuota=200%` passed in 399 s and under `CPUQuota=100%` in 609 s, both with 0 failed activities.
The cloud guest shows about 300 failed (mostly cancelled) activity completions in every run, so it is chronically
saturated; cloud-only suspects are Fly-to-Temporal Cloud latency, 15 concurrent fleets in one namespace and the
autoscaler clone. Status stays open as an observability gap.

Single diagnostic that would capture it next time: a per-attempt worker record for `post_agent_message` with
`activity.info()` attempt, `started_time`, `current_attempt_scheduled_time`, the start lag at body entry, and
httpcore trace phase timestamps (pool assigned, headers sent, body sent, response received) when an attempt takes
longer than 5 s.

