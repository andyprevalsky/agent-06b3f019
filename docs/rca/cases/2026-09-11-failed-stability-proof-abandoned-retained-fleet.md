---
id: 2026-09-11-failed-stability-proof-abandoned-retained-fleet
date: 2026-09-11
title: A failed stability proof exited without recovering its retained fleet owner
surface: cross
component: cloud-fleet-proof-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-fleet-infra-stability-proof finalized a failed slice after the fleet controller quarantined its ownership registry without handing that exact owner to recovery
symptoms:
  - "guest shutdown request failed (HTTP 000)"
  - "retaining fleet ownership"
  - "failed proof left ten Machines started after its controller exited"
tags:
  - cloud-fleet
  - ownership
  - cleanup
  - cancellation
  - supervision
sources:
  - PR #1299
  - fleet run capability-stability-20260911135448-5408
  - fleet run 20260911-065448-5845
repro: scripts/tests/fleet-stability-cleanup.test.py
status: open
---

## Problem

Proof 12 stopped at 14:11:43 UTC on September 11, with controller exit 70
and zero accepted slices. All ten tasks honored the temporary 300-second
execution backstop. Three post-execution metrics failures were followed by
three guest shutdown requests returning HTTP 000. The fleet controller
retained the complete exact-owner registry rather than destroy resources
without cleanup proof. Genuine guest cleanup acknowledgements arrived later,
between 14:13 and 14:20, after that controller had exited.

The preserved inventory at 16:32:49 UTC still showed all ten primary Machines
started. The ignored launch wrapper had appended the exit code but left its
active status as `running`. The parent subsequently recovered the exact owner
through the canonical recovery command, independently verified the ten
Machines and eleven volumes terminal, verified nine browser sessions terminal,
and published all ten evidence bundles. Recovery does not give the failed
slice acceptance credit.

## Diagnosis

The path was task execution -> guest cleanup acknowledgement -> fleet ownership
quarantine -> evidence wrapper rejection -> proof finalization. The first bad
ownership boundary was the last transition: the proof stopped supervising
resources when the child command returned a failure, even though the child's
durable registry explicitly retained them.

`cloudbench_confirm_guest_shutdowns` rejects an unreachable status proxy.
`run-bench-fleet` then sets the batch's `KEEP_CLONES=1`, persists the unconfirmed
guest state, and skips provider reaping. This preserves the safety contract.
The ignored evidence wrapper rejected the failed lifecycle and returned 70.
The canonical stability-proof loop recorded the infrastructure failure and
exited without calling exact-owner recovery. Increasing task or guest timeouts
would not repair this missing ownership handoff.

The archive searches were:

- `retaining fleet ownership guest shutdown HTTP 000`
- `failed proof exits stranded machines stale running status recovery`

The July 15 Bash signal-forwarding case and September 9 registry-retirement
case are relatives. Their solutions and human feedback require exact ownership
and continued fail-closed handling of malformed identity. This incident also
occurs on an ordinary child failure, without a user signal, at a different
supervisor boundary. The worker delay that first prevented timely guest ACKs
has its own investigation; it is not diagnosed by this case.

## Reproduction

`python3 scripts/tests/fleet-stability-cleanup.test.py` drives the actual proof
entry point in a private Git fixture, with external fleet/recovery commands
and private resource ledgers. The fixture launches real local processes and
uses the repository's actual tracked-session helper. It makes no Fly, browser,
or model calls.

The first four permanent cases failed against the original proof controller:
normal failure, evidence-wrapper exit 70, failed recovery, and SIGTERM all
reached the assertion that the exact owner's cleanup must be invoked. The
valid before log is
`.context/acceptance/proof12-cleanup-independent-review/permanent-before-valid.log`.
Two earlier fixture attempts lacked a valid Polar catalog shard and are not
causal evidence. The same four cases passed after the supervisor change in
`permanent-after-first.log`; subsequent cases cover descendants, malformed
group identity, false recovery acknowledgement, dangling audit links,
incomplete terminal audit metadata, transient process-inspection failure, and
failed slice/summary log consumers.

The fake recovery command checks that the fleet producer is gone, that the
supervisor has positively recorded process-group drain, and that proof
finalization has not occurred. It then removes only the exact owner's private
ledger and writes its bound terminal audit. Tests assert unchanged unrelated
ownership, no next slice, zero acceptance credit, original failure, and a
truthful retained state when recovery fails. These prove the controller
ownership mechanism, not any individual benchmark's business outcome.

## Solution

The canonical proof creates a durable per-slice cleanup obligation before
launch. Each fleet/evidence command runs beneath the existing birth-identified
session leader. Its log is streamed from a durable file, so a pipe consumer
never becomes the resource owner. The existing waiter proves the owned group
drained, including surviving descendants, before recovery can run.

After ordinary completion as well as cancellation, the supervisor discharges
that exact owner through `run-bench-fleet --recover-stale-owner`. It uses the
canonical recovery entry point rather than the optional evidence wrapper.
The proof preserves the original failed classification and aborts the
remaining slices. Successful recovery changes cleanup status, not acceptance.

The outer proof now forwards cooperative signals to the exact waiter instead
of deferring them behind a foreground pipeline. That waiter retains its
existing cancellation and drain bounds. Further cancellation does not kill a
provider-recovery process that has taken ownership of cleanup. An unproven
process identity cannot authorize provider recovery.

Cleanup success requires registry retirement and the terminal audit's exact
owner, workspace, run, and app metadata, plus equality of the shared audit and
its run-local mirror under the existing source/digest binding. A dangling
link, two-field terminal marker, changed audit, or successful recovery exit
with a retained registry cannot produce a verified receipt. Failed recovery
retains ownership and reports `failed_retained`. Per-slice cleanup receipts
are linked from the atomically replaced canonical summary.

Adversarial review found that the initial audit shortcut accepted a dangling
link and a two-field terminal meta. Both permanent cases failed against the
saved first candidate (`audit-shortcut-before.log`) and passed with complete
audit binding. A targeted external `ps` fault also reproduced the draft
observer's incorrect treatment of unknown process state as absence
(`unknown-probe-before.log`); the unchanged test passes after distinguishing
those states. The failed-summary-logger test found cleanup succeeded but a
failing diagnostic write under `set -e` prevented final status publication;
`log-fault-after.log` records that failure and `log-fault-fixed.log` records
the unchanged passing pair. Log failure stays separate from original fleet
exit and cannot prevent cleanup or status publication.

The log relay receives completion through an anonymous pipe rather than a
new file, so ENOSPC cannot leave it waiting for an unwritable completion
marker. This adds no timeout. The regression is registered in
`fleet-infra-stability-proof.test.sh`, an existing mandatory deploy command.
A further independent fault rejected all body/waiter identity records and the
terminal exit-file write. Although fleet recovery and summary finalization
finished, the outer supervisor remained alive because it still polled those
missing files. The permanent case failed before the fix and passed unchanged
after completion moved to an anonymous pipe with EOF plus an actual pipeline
wait. A terminal frame alone cannot release the supervisor while its body or
logger remains live; rejected frame publication falls back to the reaped
pipeline's failure. Optional diagnostic files no longer control liveness.

The same review found `SKIPPED` task results counted toward a capability slice.
The unchanged actual-controller regression failed before and passed after the
classifier required actual `PASSED`/`FAILED` execution. Both causal results are
in `independent-edge-permanent-before.log` and
`independent-edge-permanent-after.log`. The former body-process-probe case now
asserts cancellation completes without that obsolete observer dependency.
The final focused suite has fourteen cases (`focused-edge-final.log`).
The enclosing suite and final source hashes are recorded in the private
implementation receipt. Normal execution remains 7200 seconds; this proof override remains
300 seconds. No readiness, recording, process, provider, or controller bound
was increased. No global pruning or resource inference from shared-account
inventory was added.

## Verification limits

The local owning-boundary before/after regression passes. The failed live
owner was separately recovered; that is not a live after-proof of this code.
The replacement cloud proof and any exact benchmark outcome gates remain
open, so this case remains open. A permanent provider outage can still prevent
positive teardown proof; the supervisor must retain exact authority and say
so rather than report completion or depend silently on another chat turn.

The user's acceptance is ten consecutive sequential slices of ten actual
tasks, with zero infrastructure outcomes and required evidence/teardown.
Ordinary `PASSED` or `FAILED` business outcomes count; `SKIPPED` does not.
All 100 business/evaluator outcomes need not pass under the temporary cap.

## Human feedback

Do not stop at a retained registry and wait for another conversation turn to
perform cleanup. Supervise the exact owner through the existing recovery
boundary. Preserve original failure and zero credit, exact process identity,
and unrelated owners. Do not relax timeouts or substitute provider deletion
for missing guest/browser cleanup evidence.

## Reusable lesson

Every proof failure path must preserve an active exact cleanup obligation or
an explicit failed-retained receipt. A workload exit, evidence publication
failure, or signal is not resource teardown. Tests must observe the external
resource ledger and process boundary before final status; merely asserting
that a cleanup callback exists would miss this failure.
