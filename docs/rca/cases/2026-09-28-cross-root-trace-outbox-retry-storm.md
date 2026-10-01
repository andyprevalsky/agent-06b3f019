---
id: 2026-09-28-cross-root-trace-outbox-retry-storm
date: 2026-09-28
title: Successful trace write retried unrelated failed outboxes on every agent
surface: agents
component: helpers/trace_archive.py async archive job
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/helpers/trace_archive.py _submit_archive_job called _drain_backend_outbox without root_agent_id after every successful write
symptoms:
  - 'trace_archive.backend_store_failed status=400 Archive ciphertext SHA-256 mismatch'
  - 'Timeout after 902s (dynamic cap=900s)'
  - 'Agent status: ACTIVE (expected COMPLETED)'
tags:
  - trace-archive
  - mass-agent
  - outbox
sources:
  - agent f0034f30-9d65-4f49-bd97-792a61d1e762
  - PR #1312
repro: agents/tests/blackbox/trace_archive.blackbox.py::test_backend_failure_spools_encrypted_outbox_and_async_drain
status: fixed
---

## Problem

The local `test-mass-agent-run-0` benchmark timed out at 900 seconds while its root remained ACTIVE. All 50 children completed by 23:45:35 UTC, the root DAG assembled the output by 23:46:32, and its verifier passed at 23:47:15. The root reached COMPLETED at 23:49:05, after the runner had paused it. During the run, backend agent requests took 3–9 seconds versus a historical p95 of 40 ms, and the worker made 11,226 failed artifact POSTs.

## Diagnosis

The archive POST failures targeted only two older roots: `7d282652-2c5b-4dd3-b8c8-461929a37bf8` (5,723) and `b217afca-6595-4eb5-bfd1-9688c2c9826a` (5,503). The current root's writes returned 417 HTTP 200s. The older roots' pending artifacts remained in the outbox, and each successful new artifact invoked a global drain at `agents/helpers/trace_archive.py:928`. Thus unrelated durable failures were retried on every current-root write. This is the first bad boundary. The archive validation errors explain why the stale pairs remained, but their underlying stored R2 manifest corruption is a separate open issue; the local pairs were valid. The active benchmark multiplied 28 stale files into 11,226 HTTP 400s, slowing the backend's agent and cache requests. This is related to prior archive outbox and manifest RCAs, but the cross-root retry storm is a distinct ownership defect.

Local reproduction: `PYTHONPATH=agents:agents/tests/blackbox agents/venv/bin/python - <<'PY'` with `runpy.run_path('agents/tests/blackbox/trace_archive.blackbox.py')['test_backend_failure_spools_encrypted_outbox_and_async_drain']` and `asyncio.run(f())`. Pre-fix assertion: `current agent archive write drained an unrelated root's outbox`. The same command passed after the source fix. The exact benchmark failed pre-fix in `agents/benchmarks/runs/20260928_235037_test-mass-agent-run-0.json`.

## Solution

Scope opportunistic outbox draining to the active root at `agents/helpers/trace_archive.py:928`. The terminal flush was already root-scoped. The permanent agent blackbox plants a pending artifact for another root and checks that a successful current-root write drains only its own failed artifact. The full `trace-archive` blackbox domain passed after the fix. At 10,000 agents, each successful write can retry only that agent's pending artifacts, so one permanently failing old root cannot multiply across other agents. The outstanding R2 manifest corruption still needs a separate RCA.

The exact unchanged mass-agent task later passed with 51/51 agents completed,
18/18 evaluators passing, 100% Fast Mode cache hit, and zero live model spend.
The passing run is
`agents/benchmarks/runs/20260929_015858_test-mass-agent-run-0.json`, root
agent `e822e258-90be-4400-9bae-8dc9d5980e68`; its
[durable FE viewer](https://www.roselabs.ai/?agent-id=e822e258-90be-4400-9bae-8dc9d5980e68)
was verified reachable with 268 messages. No
`trace_archive.backend_store_failed` event appeared in that isolated stack's
worker logs. An intervening exact run completed all agents but exposed a
separate missing-title contract, recorded in
`2026-09-28-root-title-coupled-to-missing-schema-cache.md`; it was fixed before
the passing full task. The old corrupted archive artifacts remain a distinct
follow-up, not a blocker to this root-scoped retry fix.

## Human feedback

None recorded.

## Reusable lesson

Scope opportunistic durable outbox retries to the work owner whose successful write triggered them.
