---
id: 2026-10-26-fly-unresponsive-host-same-machine-update-replay
date: 2026-10-26
title: One Fly host answering 408 to a boot-config update aborted a 70-copy sharded run because the fleet only replayed the same Machine
surface: infra
component: run-bench-cloud boot-launch / run-bench-fleet boot-config barrier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud boot_update_with_capacity_recovery — replayed a same-ID `flyctl machine update` against a host that kept timing out, and run-bench-fleet's boot-config barrier exited on the first unapplied child with no replacement path
symptoms:
  - "failed to update VM 863745ce73de38: request returned non-2xx status: 408"
  - "boot-launch: could not set machine env/command after retries."
  - "boot config failed before barrier release: browser-auth-saved-password-retry exited without a ready marker (1/2 ready)"
  - "canonical parent N2 failed before worker admission"
tags:
  - fly
  - cloudbench
  - boot-launch
  - fleet-barrier
  - infra-canary
  - sharded-campaign
sources:
  - benchmark run original600-1792976687768099299 shard-01 (descend-full69-20261023 rerun on ae2f7366c, controller 8045e9c6612648)
  - fleet run 20261026-010709-1182, Machine 863745ce73de38, Fly request 01M5TWKRQW2VX1JSXAQHWGVFME-iad
  - commit on branch rca/BOOT408-replace-stuck-host (see final handoff)
repro: scripts/tests/cloudbench-env.test.sh (unresponsive Fly host boot update + fleet host-unresponsive replacement checks)
status: fixed
---

## Problem

The full descend rerun on ae2f7366c aborted before any task ran. Shard-01's
startup infra canary (N=2) cloned Machine 863745ce73de38 for
browser-auth-saved-password-retry at 01:07Z. Every boot-config
`flyctl machine update 863745ce73de38 … --skip-start` returned
`failed to update VM 863745ce73de38: request returned non-2xx status: 408`.
The child retried the same Machine 10 times (8 s apart, 90 s cap each), gave up
at 01:19Z with `boot-launch: could not set machine env/command after retries.`,
and the fleet barrier exited (`… exited without a ready marker (1/2 ready)`).
The campaign recorded `canonical parent N2 failed before worker admission`, the
shard failed before global release, and the operator cancelled all 70 copies.
`cloudbench-boot-update.log` was truncated per attempt, so only the final 408
survived; the earlier nine responses are unrecoverable from this run's export.

## Diagnosis

1. Fly 408 on a same-ID machine update is the API gateway timing out on the
   flyd host that owns that Machine. A Fly Machine is pinned to its host; the
   update cannot be served by any other host. The second canary Machine
   (805326f612e108) applied its config normally in the same window, so the
   fault was host-local, not app- or org-wide.
2. `boot_update_with_capacity_recovery` classified only org Machine limits,
   429/resource_exhausted and CPU-overcommit; every other response, including
   repeated host timeouts, was replayed against the same ID until the ordinary
   retry budget ran out (~12 minutes of the boot deadline).
3. Deepest owned cause: the fleet boot-config barrier treated every unapplied
   child as fatal (`exit 1`) and had no way to re-provision one slot, even
   though the clone was disposable and the fleet already owns a bounded
   claim-or-clone path (`provision_primary_machine`). One unhealthy provider
   host therefore aborted every copy behind the strict barrier.
4. Observability: the update log was overwritten (`>`) on each attempt.

Local reproduction (fake `flyctl` that answers the exact 408 for one Machine,
real `_with_timeout`), run against the ae2f7366c scripts:
`bash scripts/tests/cloudbench-env.test.sh` →
`FAIL: unresponsive-host boot update replayed 10 same-ID mutations (expected 3 consecutive host timeouts)`;
with only the child fixed:
`FAIL: missing fleet function fleet_replace_host_unresponsive_child`.
The same command passes 5/5 on the fix.

## Solution

- `run-bench-cloud`: each attempt's output goes to a scratch file, is
  classified from that attempt alone, and is appended to
  `cloudbench-boot-update.log` under
  `=== boot update attempt N at <UTC> rc=R ===`. After 3 consecutive
  `failed to update VM <mid>: request returned non-2xx status: 408` responses
  naming the same Machine (app-wide 5xx/429 keep the normal budget)
  (`CLOUDBENCH_BOOT_UPDATE_HOST_TIMEOUT_LIMIT`), it stops replaying and writes
  `boot-config-host-unresponsive` with the exact Machine ID. Capacity waits
  reset the counter; no timeout or retry count was raised.
- `run-bench-fleet`: the per-bench child launch is now
  `launch_fleet_bench_child <bench-index> <bench> [slot]`. The barrier calls
  `fleet_replace_host_unresponsive_child` before aborting: only for this run's
  disposable clone (`.cid` = `clone <mid>`), once per slot, before the
  unchanged barrier deadline, after its autoscaler exited with no worker
  clones. It moves the failed attempt's evidence (including the
  old `runtime-evidence.*` ownership the relaunch would otherwise refuse) to
  `host-replaced-<mid>/`, takes a fresh clone through the existing
  `clone_machine_target`, and relaunches the same slot. A failed clone
  restores the exact original failure state for the strict abort. The old Machine stays in the fleet
  registry and per-bench ledger, so the normal exact-owner teardown destroys
  it. Pool claims, archived reuse, a second unresponsive host, or any other
  boot failure keep the strict abort; the canary and barrier are unchanged.
- 10k agents: the work is per-child and bounded (≤3 updates on a dead host,
  at most one extra clone per slot); there is no shared lock or fleet-wide
  scan. A replacement clone passes through the existing admission and rate
  pacing.
- Golden reference: `claude-code-src/src/services/api/withRetry.ts:54`
  (`MAX_529_RETRIES = 3`) and `:334-347`. After 3 consecutive overloaded
  responses from one target, Claude Code stops retrying it and switches
  to a fallback target with `FallbackTriggeredError`. `withRetry.ts:760`
  treats 408 as retryable. This fix converges on that pattern: a bounded
  number of consecutive 408s on one Machine, then a different target.
  Sibling failure also prevented: any fleet width with a single wedged host.
- Adversarial review found that the first version would fail on relaunch
  because the old `runtime-evidence.*` files stayed in place. It also left
  inconsistent state on a failed replacement and matched app-wide 5xx. All
  three were fixed, with regression cases.

## Human feedback

None recorded from the user directly. The parent /descend assignment scoped the fix: do not raise timeouts or retry counts, do not weaken
the canary or the strict barrier, and keep it at 10k agents.

## Reusable lesson

When a provider resource is pinned to a host, stop replaying a mutation after a few consecutive host timeouts and replace the resource through its owned lifecycle, without aborting the whole fleet.
