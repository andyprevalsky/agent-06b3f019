---
id: 2026-11-16-cloudbench-cancel-before-run-sh-cleanup-trap-left-no-stack-receipt-so-guest-refused-ack
date: 2026-11-16
title: A guest cancelled during run.sh dependency setup had no stack cleanup receipt, so the driver refused its cleanup ACK and the owner was quarantined
surface: infra
component: cloudbench-guest-cleanup-ack
classification: undetermined
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: candidate (causality unproven) is scripts/run.sh, which installs the EXIT trap that publishes the stack cleanup receipt (cleanup -> run_publish_stack_cleanup_status) only near the end of startup; before that the EXIT trap is release_seed_lock_if_held, so a TERM during DB setup or Playwright install exits without writing cloudbench-stack-cleanup-<token>.status, while scripts/cloudbench-run.sh publish_cleanup_ack requires that receipt whenever STACK_PID is set
symptoms:
  - "awk: cannot open /data/repo/.context/cloudbench/cloudbench-stack-cleanup-7a0da79e0b9a4a91ad4581f233852889-0.status (No such file or directory)"
  - "FATAL: stack cleanup receipt is malformed; refusing guest cleanup acknowledgement"
  - "FATAL: could not publish guest cleanup acknowledgement"
  - "guest cleanup was not acknowledged; machine ownership must be retained (HTTP 500)"
  - "active exact guest has no sealed provider-session identity"
tags:
  - cloudbench
  - guest-cleanup-ack
  - run-sh
  - exit-trap
  - infra-stop
  - quarantine
sources:
  - fleet run 20261116-012242-1800620 (owner 7a0da79e0b9a4a91ad4581f233852889, task polar-bu-090, Machine 8d99357b2790d8, source commit 5b1f0b5186)
  - fleet run 20261116-012242-1800620 original-volume capture of Machine 8d99357b2790d8 (bench.log, stack.log; capture archive sha256 recorded in its provenance)
  - commit b55e854061 (recovery path for the resulting quarantined owner; does not fix this cause)
repro: none-recorded
status: open
---

## Problem

The 01:27Z infra stop cancelled fleet run 20261116-012242-1800620 about 265 s into guest startup.
The controller delivered the authenticated shutdown (HTTP 202). The guest was still in `run.sh --benchmark`
dependency setup: the bench.log on the original volume ends with
`📦 Ensuring Playwright browser assets...`, `Installing Chromium assets for Node Playwright`, then
`guest shutdown requested; draining benchmark root before stack teardown`,
`awk: cannot open .../cloudbench-stack-cleanup-<token>.status (No such file or directory)`,
`FATAL: stack cleanup receipt is malformed; refusing guest cleanup acknowledgement` and
`driver exited rc=143`. No cleanup ACK, services.json, backend.log or run.json exists on the volume.
The controller then saw HTTP 500 and quarantined the owner, so the Machine and volume stayed allocated until
a manual stop and the new pre-backend recovery path.

## Diagnosis

`scripts/cloudbench-run.sh` `publish_cleanup_ack` requires a well-formed, clean stack cleanup receipt
whenever `STACK_PID` is set; a missing file fails its awk parse as "malformed". The receipt is written only by
`scripts/run.sh` through `run_publish_stack_cleanup_status` (`scripts/lib/run-process-cleanup.sh`). That happens from
`cleanup()` (installed by `trap 'release_seed_lock_if_held; cleanup' EXIT` near the end of startup) or from
`fail_required_seed_dump`. During earlier startup, including the seed restore, migrations and Playwright install,
the EXIT trap is only `release_seed_lock_if_held`, so a TERM in that window exits run.sh without a receipt.
The driver's separate pre-stack seal covers only `STACK_LAUNCH_ATTEMPTED=0`, not a launched stack that had not yet
started services. This is a candidate causal chain from source and the captured logs. It has not been reproduced
locally, so causality is unproven.

## Solution

Open. The likely fix is to install an early EXIT/TERM handler in run.sh, as soon as `RUN_STACK_CLEANUP_STATUS_FILE`
is known. It would publish `pending`, release any bootstrap resources it owns (seed lock, bootstrap DB), and then
publish `clean` or `failed`, the same way `fail_required_seed_dump` already does. The driver then gets a truthful
receipt for a stack that never started services. Required regression: TERM `run.sh --benchmark` during the
dependency-setup window in the cloudbench driver fixture and assert that a clean v2 receipt and the guest ACK are
published, with no services manifest. Until this lands, the operator recovery is the pre-backend-exit native stop,
original-volume capture and forensic archive path from commit b55e854061 onward.

## Human feedback

None recorded.

## Reusable lesson

Any process whose receipt a parent requires must publish that receipt from its very first cancellable moment, not only after its main cleanup trap is installed.
