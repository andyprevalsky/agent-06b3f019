---
id: 2026-11-15-fly-cutover-stopped-wait-budget-shorter-than-native-replacement
date: 2026-11-15
title: Cooperative Fly cutover gave up its stopped-state wait after ~180s while a new-image update took 489s, and single transient Machines API reads had no replay
surface: infra
component: retained-agent-machine
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: scripts/retained_agent_machine.py wait_stopped — a fixed 9 x 20s /wait budget (sized to stay inside the 500s lease) raised the native 408 "still replacing" answer as a failure; Fly.request sent every GET exactly once
symptoms:
  - "urllib.error.HTTPError: HTTP Error 408: Request Timeout"
  - "completed = wait_stopped(fly, updated_version)"
  - "TimeoutError: The read operation timed out"
  - "KeyError: 'FLY_API_TOKEN'"
tags:
  - deploy
  - fly
  - cutover
  - retry
sources:
  - PR #2123 (merge 5860080c279a, deploy-agents run 43666358952)
  - PR #1549 (deploy-agents run 39351185309)
  - PR #1584 (cutover job 5b5a47e3)
  - commit 4ae0909e85 (PR #1535, the 9 x 20s wait)
  - memory:fly-cutover-transient-reset-no-retry
repro: scripts/tests/retained-agent-machine.test.py
status: open
---

## Problem

Production run 43666358952 failed in "Cooperative Fly deploy + generation cutover" at 02:17:09Z. The trace ran `prepare` → `operate("reuse")` → `wait_stopped` → `Fly.request` → `HTTPError 408`. The cutover had to be resumed by hand. It was the third manual resume in this cutover after a single Machines API answer: on 2026-10-20 (run 39351185309) a `ConnectionResetError` on a DRAINING GET, and on 2026-10-26 (PR #1584) `TimeoutError: The read operation timed out` on a read. Resuming through `scripts/deploy production --lanes fly --resume-fly` then failed with `KeyError: 'FLY_API_TOKEN'`, because the resume child loaded only `back-end/.env`.

## Diagnosis

The native events were read-only GETs captured after the failure. Machine `8dd736ae056578` started its new-image update (`launch created user`) at 02:13:59.7. It reached `update stopped` / `promote stopped` only at 02:22:08.4, 489s later. Sibling `8dd719ae13de78` took 243s (02:14:00 → 02:18:03). `wait_stopped` sends `GET /wait?state=stopped&timeout=20` and treats Fly's 408 as "still replacing". It gave up after 9 attempts: 02:13:59 + ~190s = 02:17:09, the failing timestamp. The budget was sized in PR #1535 for a ~20s replacement and capped at 180s to stay inside the 500s lease, so a slow image replacement always failed the cutover.

Separately, `Fly.request` called `urlopen` once for every request. A single reset, read timeout, 429 or 5xx on an idempotent GET, the exact read-only runtime exec probe, or the cutover's inventory list therefore aborted the whole state machine. That is what happened on 10-20 and 10-26. The deepest owned cause is that the owning helper mixed two meanings of failure. It did not separate a native "not yet" (408 from /wait), which should keep waiting to a deadline, from a transient transport fault on a read, which should be replayed a bounded number of times, from a write whose outcome is unknown, which must never be blindly replayed.

Repro: `scripts/tests/retained-agent-machine.test.py` `test_slow_native_replacement_is_awaited_under_a_refreshed_lease_until_the_deadline` drives `operate("reuse")` against a fake clock and a fake Fly that keeps answering /wait with 408 until 489s after the update. On a066f04b79 it fails with the production trace (`wait_stopped` → `HTTPError 408`). `test_native_reads_replay_transient_fly_failures_but_writes_do_not` fails on the first transient GET. `worker-pool-cutover.test.py` `test_native_reads_and_exact_runtime_probe_replay_transient_fly_failures` fails on the probe exec. `deploy-prod.test.py` `test_resume_fly_*` fails with `KeyError: 'FLY_API_TOKEN'`. All pass after the fix.

## Solution

- `Fly.request` replays GETs, and only requests a caller marks idempotent, up to 3 attempts with 1s/2s backoff on 408/429/5xx, `URLError`, `ConnectionError` and `TimeoutError`. Writes (update, metadata, start, stop, lease acquire/release) are sent exactly once.
- `wait_stopped` waits on 408 until a 900s deadline. Other transient faults are still capped at 3 in a row, and non-transient errors fail at once. While it waits, `Fly.keep_lease` refreshes the holder's own lease every 240s (`POST /lease?ttl=500` with the held nonce, fly-go `RefreshLease`), so the 500s lease cannot lapse. A refresh that names another holder fails closed.
- `OwnedFly` marks only the exact `RUNTIME_QUEUE_PROBE` exec as replayable, and `NativePool.list` replays its inventory GET.
- `deploy_prod.py --resume-fly` passes `FLY_API_TOKEN` from the environment, else from `agents/.env`, never shows it in recorded commands, and fails with an actionable message when it is missing.

10k-agent behavior: deploy-time only, per-Machine and bounded (≤3 attempts per read, about 45 waits plus about 4 lease refreshes per Machine at worst). Nothing touches the agent hot path.

## Human feedback

None recorded.

## Reusable lesson

When a provider wait answers "not yet", wait against a deadline and keep the guarding lease alive instead of counting attempts; replay only provably idempotent reads on transient transport faults, and never replay a write whose outcome is unknown.
