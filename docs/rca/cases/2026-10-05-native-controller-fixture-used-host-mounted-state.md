---
id: 2026-10-05-native-controller-fixture-used-host-mounted-state
date: 2026-10-05
title: Native controller dispatcher placed concurrent fixture state on a Mac bind mount
surface: harness
component: cloudbench-controller-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The Linux dispatcher bound fixture-tmp from Mac as the fixture TMPDIR
symptoms:
  - workstream A's provisioning must succeed alongside a concurrent run
  - could not read pool inventory before refresh
  - FileNotFoundError replacing state.json.tmp in the unchanged fake provider
tags:
  - cloudbench
  - controller
  - fixtures
  - concurrency
  - ownership
sources:
  - commit f447fd392e4eeb4376c8fa1324b2237b1e366243
  - commit f1e756cea51c1946ad80ea8904d88ca0547452ce
  - task canonical cloudbench-multi-workstream deployment gate
repro: scripts/tests/cloudbench-multi-workstream.test.sh scenario 1 through the normal Mac dispatcher
status: fixed
---

## Problem

The normal native controller gate failed its first concurrent-provisioning
scenario after 55.124 seconds. Both controllers used the unchanged fake provider,
but their mutable fixture state lived on a writable Mac bind mount. A previous
native run used Linux-local temporary storage and passed this scenario.

## Diagnosis

The original failed snapshot and stage remain retained. Controller A rejected
the first inventory read; controller B proceeded. The controller deliberately
suppressed that read's stderr, so the original underlying exception was not
captured and is not claimed as independently proven.

An isolated reduction ran the exact retained fake provider and valid state with
two concurrent readers. Its unchanged locked-state context rewrites
`state.json.tmp` and atomically replaces `state.json`, including for reads.
Established-directory controls passed 50 calls on both filesystems. Fresh-pair
controls failed 2 of 10 host-bind calls at the actual replacement boundary with
`FileNotFoundError`, while all 10 Linux `/tmp` calls passed. An independent
validator repeated that exact setup and observed the same 2/10 versus 0/10
result in 0.502 seconds. The established-directory inverse remains retained;
this is a demonstrated fresh-state boundary, not a claim that every host-mounted
write fails.

## Solution

Keep mutable state in the owning container's writable-layer `/tmp`. Seal only
the two source mounts as read-only. Preserve the container until diagnostics
have been exported: verify its exact CID, name, owner label, image and mounts;
stop it with the existing 30-second grace; copy only its `/tmp` into the private
snapshot; remove that exact container and prove its absence. Skip export if stop
fails, and always attempt exact removal even if export fails. A failed export
fails the evidence verdict. Exported directories use mode 0700 and regular files
0600 without following symlinks. Ephemeral tool checks still use `--rm`, and
inherited proxies stay intact.

Nine compact controls pass, including foreign-image and mount inverses, native
storage, private export, copy failure and exception cleanup, stop failure,
cancellation ordering, signal-retention inverses, and CID handling. Independent
actual TERM cancellation returned 143, exported the exact observed fake-provider
state among 3,251 private files, proved its exact container absent, and preserved
an unrelated inert sibling through retirement. The final normal Mac dispatcher
completed all 32 scenarios with exit 0 in 1,276.170 seconds on clean
`f1e756cea51c1946ad80ea8904d88ca0547452ce`. Its exact native container was absent;
all 2,147 exported regular files were mode 0600 and exported directories were
0700. The executed source hashes remained unchanged throughout that run.
Production controller policy, provider locking, retries,
assertions and budgets are unchanged. The distinct signal-retention predicate
repair is recorded in
`2026-10-05-controller-fixture-deleted-canceled-evidence.md`.

The next full run passed the original concurrent-provisioning scenario, then
failed a distinct intentional signal-cleanup contract. Its runner also reported
an unproven export verdict despite exact container absence; that original
underlying exporter cause was not captured and remains unexplained. A bounded
instrumented run on the corrected child contracts subsequently proved all
retirement branches and private export in 6.212 seconds. No further exporter
source change is justified by that successful reproduction; the original failed
receipt is retained alongside it.

Final source-bound receipts are
`.context/deploy-runs/20261006-024302-65153/native-storage-repair-final/controller-full-normal-final-summary.json`
and `native-storage-final-artifact-privacy.safe.json` under the same deploy-run
directory. The strict composite coverage acceptance separately passed at 82%,
retaining the original failed aggregates and unchanged funded successes. This
final normal gate verifies the repaired storage/export contract; it does not
retroactively prove either original suppressed exception or the later
unexplained export verdict.

## Human feedback

Preserve both failed receipts and successful inverses. Repair the owning offline
runner, retain funded coverage when actual runtime dependencies are unchanged,
and verify the normal native gate without repeating unrelated paid successes.

## Reusable lesson

A Linux process alone does not guarantee Linux filesystem semantics when its
mutable state is host-mounted. Keep fixture state native, then export diagnostics
before retiring the exact owner.
