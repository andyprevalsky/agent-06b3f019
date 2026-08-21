---
id: 2026-08-19-refresh-deps-sftp-tunnel-timeout-aborts-fleet
date: 2026-08-19
title: Fleet --refresh-deps aborted every task because warm-box sftp put had no retry on Fly tunnel timeout
surface: infra
component: cloudbench-refresh-deps
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud warm_source_fetch_ref — single-shot `FLY ssh sftp put` of cloudbench-fetch-ref.sh
symptoms:
  - "tunnel unavailable: Error contacting Fly.io API"
  - "timed out (context deadline exceeded)"
  - "failed to upload cloudbench-fetch-ref.sh"
  - "central dep refresh failed; refusing to provision task machines"
tags:
  - cloudbench
  - refresh-deps
  - sftp
  - fly-api
  - fleet
sources:
  - PR #1001
  - commit b51451a6b8518114db356ac035f4a3bd5cba20b6
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_warm_source_fetch_ref_retries_transient_sftp_tunnel_timeout
status: fixed
---

## Problem

`scripts/run-bench` for the six AgentCard lifecycle tasks detached fleet
`20260819-190754-47985` (epoch 3). The controller started warm source
`683e47df5094d8` and `--refresh-deps` began git-syncing
`f9ad6715cc0d572a5ad54c3dbedae73bf5c5ee00`. The first `flyctl ssh sftp put`
of `cloudbench-fetch-ref.sh` printed
`Error: tunnel unavailable: Error contacting Fly.io API when probing ... timed out (context deadline exceeded)`,
then `failed to upload cloudbench-fetch-ref.sh` and
`central dep refresh failed; refusing to provision task machines`. No task
machine was created. Controller PID 47985 exited.

## Diagnosis

Guest driver staging already retries `ssh sftp put` up to
`CLOUDBENCH_STAGE_ATTEMPTS` (default 20) because Fly's Machines API tunnel
is known-flaky. `warm_source_fetch_ref` (added for the empty-token I-01
fix) issued the same sftp once and treated a transient Fly probe timeout as
fatal.

Critical path: `run-bench` → `run-bench-fleet` → `--refresh-deps` →
`warm_source_fetch_ref` → single `FLY ssh sftp put` → abort → no clones.

Local owning-boundary repro
`test_warm_source_fetch_ref_retries_transient_sftp_tunnel_timeout` on the
buggy helper measured `FETCH_REF_ABORTED attempts=1` (exit 14) with the
exact tunnel-timeout stderr instead of `FETCH_REF_OK attempts=2`.

Archive searches (`tunnel unavailable`, `context deadline exceeded`,
`refresh-deps fly api timeout`, `sftp`) found relatives: I-01 empty-token
refresh-deps (same helper, different boundary), 2026-07-15 unthrottled
clone burst (no Fly retry), 2026-07-20 transient proxy-init classified
fatal. Novel sibling of I-01, not a recurrence of the token bug.

## Solution

`warm_source_fetch_ref` uploads through `cloudbench_retry_command` with
`CLOUDBENCH_WARM_FETCH_REF_SFTP_ATTEMPTS` (default 5) and a 3s delay,
removing `/data/cloudbench-fetch-ref.sh` before each attempt so flyctl sftp
will overwrite. Permanent failure still fails closed after the budget.

Cemented by
`test_warm_source_fetch_ref_retries_transient_sftp_tunnel_timeout`.
Unchanged assertion: first sftp prints the tunnel timeout, the helper must
retry and succeed (`FETCH_REF_OK attempts=2`).

## Human feedback

None recorded.

## Reusable lesson

A Fly sftp/ssh path that already retries on the guest-staging sibling must
retry on the warm-box maintenance sibling. A single known-transient Fly
API timeout must not abort a fleet before any task starts.
