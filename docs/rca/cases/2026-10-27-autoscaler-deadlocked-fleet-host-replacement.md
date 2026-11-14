---
id: 2026-10-27-autoscaler-deadlocked-fleet-host-replacement
date: 2026-10-27
title: Mandatory autoscaler waited forever for the boot-config release, deadlocking the fleet's one-clone replacement for a Fly host that returned 408s
surface: infra
component: run-bench-fleet
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-fleet bench_autoscaler — the boot-launch pre-release wait `while [ ! -f "$BOOT_CONFIG_BARRIER/release" ]; do sleep 0.2; done` never checked benchmark-child.finished, while fleet_replace_host_unresponsive_child waits for that autoscaler to exit before cloning a replacement
symptoms:
  - "boot update: Fly host for d8d99353a46378 timed out 3 consecutive times; the Machine needs a replacement"
  - "request returned non-2xx status: 408"
  - Original exit code 125 with no "cloning a replacement" line
  - autoscaler.log contains only "Terminated"; .startup-state.json stuck at staging
  - fleet waits silently up to the 1800 s boot-config barrier deadline, then aborts
tags:
  - fleet
  - autoscaler
  - boot-launch
  - fly-408
  - host-replacement
  - descend
sources:
  - benchmark run 20261027-191440-2597636 (polar-bu-007 r002-j0017, campaign-20261027-191411-2591810, Machine d8d99353a46378)
  - commit 34ff3f23e (descend/polar-k3-recovery, failing source)
repro: scripts/tests/cloudbench-env.test.sh (autoscaler boot-release wait checks)
status: fixed
---

## Problem

Polar k2 iteration 1 (source `34ff3f23e`) ran 20 copies. Copy
polar-bu-007 r002-j0017 cloned fresh Machine `d8d99353a46378`. Its boot-config
`flyctl machine update` then returned HTTP 408 three times from the same Fly
host:

- 19:27:17Z, request `01M5ZD7JGWFCVA07Q9DWGVYCTK-sjc`
- 19:28:31Z, request `01M5ZD9V3RGHZC06BJ6M9DASRX-sjc`
- 19:29:53Z, request `01M5ZDCAFB5S2JARYTG5XP5X5V-sjc`

`run-bench-cloud` marked the host unresponsive and the child exited 125 with
"the Machine needs a replacement". The fleet never cloned that replacement.
The coordinator stopped the campaign at 1/20 infra by hand at 19:32:24Z.

## Diagnosis

The evidence is the launch owner's immutable copies: `fleet-child.log`
sha256 `e5025434…7053` and the task-directory tarball `aca4484b…452d`.

The replacement should have been eligible, but no refusal branch was ever
reached:

- `.cid` was `clone d8d99353a46378`.
- `worker-clones.ids` was empty.
- The child wrote `benchmark-child.finished` (`125`) at 19:29:53.63Z.

The fleet stalled instead:

- The mandatory autoscaler, alive since 19:26:08Z, was still running at the
  19:32:24.78Z TERM. Its log holds only "Terminated".
- The fleet controller printed neither the replacement line nor the barrier
  abort.

In `bench_autoscaler`, the boot-launch path waits for
`$BOOT_CONFIG_BARRIER/release` in an unbounded loop that never checks the
child's finished marker. A child whose boot update failed never receives that
release. The fleet had already entered `fleet_replace_host_unresponsive_child`, which
was blocked waiting for the same autoscaler to exit, bounded only by the
1800 s barrier deadline. The "🔁 cloning a replacement" line prints only after
that wait. The two waited on each other, so the designed one-clone recovery
could never run.

A second deadlock sat behind the first, found by the independent review.
After relaunching the slot, the replacement waited for the new autoscaler's
readiness (`wait_for_mandatory_autoscaler_startup`, 600 s). That autoscaler
also waits for the boot-config release before it can be ready, and the release
follows the replacement. Fixing only the first wait would have turned a
30-minute hang into a 10-minute abort.

The existing replacement test stubbed `fleet_job_running` as already exited,
so it never exercised a live autoscaler.

Classification:

- **Provider transient:** the 408s, which are confined to one host.
- **Owned defect:** the deadlock that turned a recoverable host failure into a
  stalled copy and a lost campaign.

## Solution

Both boot-launch waits in the autoscaler now check `benchmark-child.finished`:
the wait for barrier release and the wait for post-config start acceptance.
On an early finish the autoscaler exits fail-closed:

- It writes `autoscaler.failed` with the reason.
- It commits no worker capacity.
- It writes no `autoscaler.completed-after-child`, so acceptance cannot pass.

The fleet's existing replacement path can then archive the failed attempt,
clone one fresh Machine and relaunch the same slot. Before the boot-config
release, the replacement no longer waits for the new autoscaler's readiness.
The normal start barrier checks every ready slot's autoscaler after release,
exactly as it does for the original launch. Its existing refusals
still apply: pool claims, a second failure, worker clones, and the deadline.

Regression: `scripts/tests/cloudbench-env.test.sh` (a `/deploy` gate)
extracts the real pre-release region of `bench_autoscaler` from
`run-bench-fleet` and checks three cases:

- A child that finishes before release makes the autoscaler exit promptly.
  This fails on `34ff3f23e`.
- A released, accepted primary still proceeds.
- A child that finishes after release but before start acceptance also exits
  promptly.
- A pre-release replacement runs the real `fleet_replace_host_unresponsive_child`
  and `wait_for_mandatory_autoscaler_startup` against a live stand-in
  autoscaler and returns at once. On the first fix alone it fails after the 3 s
  startup wait used in the test.

Scaling: the autoscaler adds one file-existence check per 0.2 s poll that it
already performs. That is constant per copy.

## Human feedback

None recorded.

## Reusable lesson

When two owners wait on each other, every wait loop must also watch the other side's terminal marker, and the test must run the real live waiter instead of stubbing it as already exited.
