---
id: 2026-07-16-cloud-calibrated-timeouts-applied-to-5-concurrent-local-smoke
date: 2026-07-16
title: Cloud-fleet-calibrated per-task timeouts were applied to 5 concurrent local agents on one Mac
surface: harness
component: deploy-pipeline
classification: configuration-error
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-predeploy-local — ran 5 concurrent agents against timeouts calibrated for 1 agent per cloud machine
symptoms:
  - local pre-deploy smoke fails on task timeouts
  - a different benchmark task times out on each run
  - chat task takes 287s at concurrency 5 vs 123s at concurrency 2
tags:
  - smoke
  - deploy-gate
  - concurrency
  - timeouts
  - flaky
sources:
  - commit 62977fe91
  - commit 340dff941
  - agent 50763f0a-3534-46ec-a9e3-21556a710ac5
  - agent 2e9e8282-187c-4f4b-9b09-4fc329a615bb
  - agent d207fc93-37ea-4446-b8ca-823e02d122e3
  - memory:project_cerebras_ratecap_chat_fallback
repro: agents/tests/blackbox/predeploy_metrics.blackbox.py
status: fixed
---

## Problem

The local pre-deploy smoke suite failed on per-task timeouts, and — the tell —
a _different_ benchmark task timed out on each run. Measured directly: the chat
task took 287s when 5 agents ran concurrently versus 123s at concurrency 2.

## Diagnosis

Per-task timeouts are calibrated against the **cloud fleet**, where the topology
is one agent per machine. The local path ran 5 of those agents concurrently on a
single Mac, so agents were CPU-starved and overran limits that are correct for
their intended topology. The randomly-rotating victim task is the signature of
resource contention rather than a task-specific defect.

The owned defect is the harness: it reused cloud-calibrated timeout budgets under
a fundamentally different local concurrency profile.

## Solution

`scripts/run-predeploy-local` now caps concurrency at `--max-concurrency 2`
(overridable via `PREDEPLOY_LOCAL_CONCURRENCY`). Result: a stable 7/7 local smoke.

Explicitly **not** benchmark tuning — no timeout, task definition, or pass
criterion was changed; only the local concurrency was brought in line with what
the machine can actually serve. Note the cache-ratchet gate in
`run_benchmark.py` remains intermittent because it depends on prod's 5-minute
Anthropic ephemeral cache warmth, but it passed in the concurrency-2 run.

## Human feedback

The user's standing rule was upheld rather than worked around: raising the
timeouts was rejected as reward hacking; the fix had to reduce contention with
timeouts unchanged.

## Reusable lesson

When a _different_ task times out on every run, treat it as host resource
contention and lower local concurrency — never raise the timeout.

## Recurrence: 2026-08-03

The exact six-task local smoke run
`961f8e74-71a5-44bf-8bfb-4152878919fc` failed three unrelated tasks together:
`browser-smoke` at 342s, `browser-biometrics-webdecoy` at 494s, and
`spawn-sub-agents` at 644s. The three passing siblings were also slow. Across
the suite, durations were 1.45–4.65× two recent green concurrency-six runs, and
host load was roughly 58/53/48 on 14 logical CPUs. The failed agents still made
correct progress: browser-smoke read Example Domain, biometrics reached seven
visible steps after a successful retry, and the spawn task returned the correct
arithmetic/verifier result after its cap. This was shared-host starvation, not
three simultaneous task defects.

The regression came from commit `340dff941`: `scripts/run-predeploy-local`
defaulted concurrency to the selected task count, restoring task-count/default-
six admission after commit `62977fe91` had fixed the local default at two. The
old blackbox fixture selected only two smoke tasks, so both implementations
looked identical. The strengthened fixture now selects three tasks, clears any
inherited `PREDEPLOY_LOCAL_CONCURRENCY`, and asserts that both the command and
persisted summary keep the default at two. It failed before the fix at
`.context/test-runs/20260803-203649-56596-e2ec7fe3` and passed after it at
`.context/test-runs/20260803-204351-55486-537183fe`.

The unchanged failed subset at concurrency two then exposed a second harness
guardrail gap. Run `709acdbe-3aed-4b62-bea8-20387fb21f91` passed
`spawn-sub-agents` in 279s and biometrics in 341s, but reported browser-smoke as
timed out after 388s. Its trace showed the browser agent had actually read
Example Domain and completed in about 158s. Biometrics cleanup synchronously
ran a roughly six-minute full credential restore on the asyncio event loop; when
the loop resumed, browser-smoke's timeout callback ran against an already
completed agent. Live-fixture setup and restore now run through
`asyncio.to_thread`, so slow credential subprocesses cannot freeze unrelated
polling lanes. The owning `live_fixture_setup_restore_yields` blackbox failed
before the fix in `.context/test-runs/20260803-211949-23724-57b6f618` and the
full benchmark domain passed after it in
`.context/test-runs/20260803-212113-57237-52fc8681`.

Final unchanged proof: browser-smoke run
`5d44afcd-f3e7-477f-9163-d65204541f91` passed in 72s at its existing 286s
dynamic cap (agent `d207fc93-37ea-4446-b8ca-823e02d122e3`). No timeout, task
prompt, evaluator, or pass criterion changed. Adversarial review accepted the
diagnosis only after the concurrency-two subset and the exact remaining task
both passed.
