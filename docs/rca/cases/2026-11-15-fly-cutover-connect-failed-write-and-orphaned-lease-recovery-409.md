---
id: 2026-11-15-fly-cutover-connect-failed-write-and-orphaned-lease-recovery-409
date: 2026-11-15
title: Fly cutover died on a retirement write that never left (connect-phase Errno 101), and the immediate FIFO recovery hit 409 on the Machine lease the dead controller orphaned
surface: infra
component: retained-agent-machine
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/retained_agent_machine.py Fly.request — a write whose connect() failed (nothing sent) was treated like an unknown-outcome write and never replayed; Fly.lease — 409 on acquire from our own dead controller's unreleased lease was fatal; worker_pool_cutover.for_each_machine dropped every error but the first
symptoms:
  - "urllib.error.URLError: <urlopen error [Errno 101] Network is unreachable>"
  - "urllib.error.HTTPError: HTTP Error 409: Conflict"
  - "with client.lease():"
  - "pool.operate(arguments, current, client)"
  - "Owned deployment child exited 1"
tags:
  - deploy
  - fly
  - cutover
  - lease
  - retry
sources:
  - PR #2105 (merge dbc7b5cc70, deploy-agents run 43669103359, job 7aab4aa1)
  - PR #2065 (merge 6a8237ec7a, deploy-agents run 43669305097, job ea1b1f4c recovering 7aab4aa1)
  - PR #2127 (transient()/replay_transient(), Fly.request replay=)
repro: scripts/tests/retained-agent-machine.test.py
status: open
---

## Problem

Every agents push deploy after 01:15Z on 2026-11-15 failed in "Cooperative Fly deploy + generation cutover".
Run 43669103359 failed at 02:59:17.82Z. The path was `run` → `for_each_machine` → `NativePool.retire` → `pool.operate("retire")` → the `idle` retirement metadata `POST`, which raised `URLError [Errno 101] Network is unreachable`. The chained traceback shows `socket.create_connection` → `sock.connect` raising, so no request byte was sent.
Run 43669305097 waited on `GLOBAL_LEASE_BUSY` from 02:49:04Z. Run 1 released the global lease, and 3s later, at 02:59:20Z, run 2 started the failed head 7aab4aa1 (`recoveringPredecessor: true`). It died at 03:02:12Z with `HTTP Error 409: Conflict` on `retire` → `client.lease()`.

## Diagnosis

- **The controllers were serialized, not concurrent.** The queue emits show run 2 blocked on the Postgres global deployment lease until run 1's child exited. It then ran 7aab4aa1 as a recovering predecessor. So the 409 holder was not a live second cutover.
- **Native timeline (Fly Machine events).** Retirement wave B stopped 8676e2ae, 830376c7, 8dd719ae and 8dd736ae at 02:57:55–02:58:01. Three `idle` writes landed at 02:58:37–02:58:48. 8dd719ae's write failed at 02:59:17, about 30s after the last success. That is consistent with an IPv6 ENETUNREACH followed by a 30s IPv4 connect timeout; `create_connection` raises `exceptions[0]`. Run 2 then wrote 8dd719ae's `idle` at 03:02:07 and got 409 on a sibling Machine of the same wave a few seconds later.
- **Rung 1: the write that never left was not replayed.** `Fly.request` sends every write exactly once (#2127). urllib reports a connect() failure, where nothing was sent, as the same `URLError` as a failure after the request was sent, so the controller could not tell the provably-safe case apart.
- **Rung 2: the lease was orphaned and the evidence was hidden.**
  - `Fly.lease()`'s release `DELETE /lease` is printed-and-swallowed only when the body also failed. Otherwise it raises, and in a wave `for_each_machine` re-raises only `(hard or errors)[0]`. A second failure in the same outage window, such as a sibling's release, was therefore dropped silently.
  - The release failure leaves the 500s native lease held until its TTL lapses.
  - The recovering controller started 3s later. Only the `--if-idle` cron path waits the 600s failed-head cadence; a push run's recovery has none. Its `POST /lease` hit the orphan and the 409 was fatal.
  - The 409 body (holder) was never logged.
- **Rung 3, why this was possible: two lease scopes.** The design has two lease scopes, the global Postgres controller lease and per-Machine Fly leases, but no rule linking them. A per-Machine lease can outlive the controller that held the global lease. Nothing treated "our own description, while we hold the global lease" as a dead predecessor's orphan.
- **Which lease was orphaned.** Run 2 re-ran prepare, wave A, then wave B (order 8dd736ae, 8676e2ae, 8dd719ae, 830376c7). 8dd719ae's own release succeeded: no "lease release failed" line, and its body failure would have printed one. In input order, only 830376c7's error could have been hidden behind 8dd719ae's. Its `operate` lease (idle write at 02:58:40.8) most likely lost its `DELETE /lease` in the same fault and lapsed around 03:07. This is inferred: Fly events do not record leases, and the 409 body and the dropped error were never logged (observability gap, fixed below). An independent verifier sub-agent reached the same boundary and holder from the raw logs. The completing owner 919dc331 finished 7aab4aa1 after 03:02 and is neither of the two runs.

Repro (fails on PR #2127 head 0e586aa396, passes after the fix):
- `scripts/tests/retained-agent-machine.test.py RetainedWorkerTests.test_connect_phase_failure_replays_a_write_that_never_left` drives the real urllib connect path against a local server with the first `socket.create_connection` raising Errno 101. Before the fix: `URLError [Errno 101] Network is unreachable`.
- `RetainedWorkerTests.test_lease_waits_out_an_orphaned_pool_lease_but_not_a_foreign_holder`. Before the fix: `HTTPError 409`.
- `worker-pool-cutover.test.py WorkerPoolCutoverTests.test_concurrent_machine_failures_beyond_the_raised_one_are_logged`. Before the fix: the second error is absent from stderr.

## Solution

Built on #2127's `transient()`/`replay_transient()`:
- **Connect-phase replay.** `retained_agent_machine` opens Machines API requests through an opener whose HTTP(S) connection raises `RequestNotSent` from `connect()` (TCP, TLS, proxy CONNECT: before any request byte). Redirects are refused, so a second hop cannot pose as the first. `Fly.request` replays any method, writes included, up to 3 times only when `not_sent(exc)`. A write whose response is lost or failed is still sent exactly once. This also covers the lease release `DELETE /lease`.
- **Orphaned lease.** `Fly.acquire_lease` treats a 409 as an orphan only when `GET /lease` names our own `cooperative-worker-pool` description. A live holder with that description is impossible, because the global deployment lease serializes controllers and each lease `POST` re-asserts ledger ownership. It polls every 10s up to `LEASE_TTL_SECONDS + 60`, a local monotonic deadline that needs no comparison with Fly's clock. A 404 (lapsed between reads) re-acquires at once. Any other holder fails at once with owner, description and expiry in the error.
- **Observability.** `worker_pool_cutover.for_each_machine` logs every concurrent failure it does not raise.
- Covers both the push-run recovery path and the `*/10` cron (`--if-idle`) path. Both already go through the queue's global lease and FIFO head, so no cutover runs beside another controller; the fix removes the remaining collision with a dead predecessor's native lease.
- 10k-agent behavior: deploy-time only and per Machine; at most 3 sends per request and about 56 lease polls per orphan. Nothing touches the agent hot path.

## Human feedback

None recorded.

## Reusable lesson

Replay a write only when the transport proves it never left (connect/TLS failure). When a per-resource lease can outlive the controller lease that serializes its holders, recognize your own dead predecessor's orphan and wait out its TTL, and log every concurrent failure, not just the first.
