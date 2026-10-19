---
id: 2026-10-19-post-update-volume-attachment-null-read-treated-as-terminal
date: 2026-10-19
title: One null attachment read after the backup update failed a healthy clone
surface: infra
component: cloudbench-disposable-volume
classification: our-bug
problem_class: other
first_bad_boundary: scripts/cloudbench-disposable-volume.py configure.inspect treated a single post-update volumes show with attached_machine_id null as a terminal ownership mismatch
symptoms:
  - "ValueError: Volume not attached to the exact owned Machine"
  - "new disposable Volume backup setting was not verified; retaining exact ownership for teardown"
  - "provisioning failed (no machine) — skipping"
  - "volume destroy attempt 2/6 id=vol_v8e05x1jmzelwo5v rc=1 response=<empty>"
  - "attached_machine_id": null
tags:
  - cloudbench
  - flyctl
  - volume-backups
  - eventual-consistency
  - disposable-reap
sources:
  - plan:/project/pr1525-evidence/volume-attach-rca/receipts-volume.txt
  - plan:/project/pr1525-evidence/volume-attach-rca/job-log-tail.txt
  - plan:/project/pr1525-evidence/volume-attach-rca/clone-machine-events.txt
  - plan:/project/pr1525-evidence/volume-attach-rca/receipt-scan-git-audits.txt
  - plan:/project/pr1525-evidence/volume-attach-rca/final-tests-vs-buggy.txt
  - commit 59b19ba00
  - commit 1a88cde8c
repro: python3 scripts/tests/cloudbench-disposable-volume.test.py
status: open
---

## Problem

PR #1540's original600 live proof, shard-01 controller 87d970b039e718,
campaign `campaign-qualified600-b0e0fbbba93c781fdafe61c3-817`, job r004-j0014
(lantern-people-enrichment), attempt 1 (run 20261019-183650-3234). The clone
step allocated the exact owned Volume vol_v8e05x1jmzelwo5v and Machine
82dd494b04d248. Storage became ready. Then the disposable Volume helper raised
`ValueError: Volume not attached to the exact owned Machine`. The job counted as
one INFRA_ERROR attempt, and attempt 2 provisioned normally.

Teardown then printed four `volume destroy attempt N/6 ... rc=1
response=<empty>` lines. These read like rejected deletes, but the audit
recorded `disposition=destroyed-provider-retained`. At 18:43Z the Volume was
`pending_destroy` and unattached.

## Diagnosis

Path: clone_machine_target → `machine clone --attach-volume` → storage
readiness → fleet_disable_disposable_volume_snapshots →
cloudbench-disposable-volume.py configure → inspect → update → inspect.

The helper's private command receipts (controller audit
`volume-backups/vol_v8e05x1jmzelwo5v/commands`) show the exact sequence:

1. `machine status -d`: the mount is the exact Volume.
2. `volumes show`: `attached_machine_id` is 82dd494b04d248 and backups are
   enabled. The first inspect passed and `intent.json` was written.
3. `volumes update --scheduled-snapshots=false` returned exit 0. Its response
   showed `attached_machine_id` 82dd494b04d248 and backups disabled.
4. `machine status -d`: the mount was still the exact Volume.
5. `volumes show`, started 113 ms after step 3 completed (219 ms after it started): `attached_machine_id` was **null** and
   backups were disabled. The helper raised on this read.

The Machines API events for 82dd494b04d248 show `launch created` at 18:37:10.
The next event is a user `destroy` at 18:37:17.755, which was our own teardown
reacting to the error. So at step 5 the Machine still existed (no event between create and our destroy),
its config still mounted the Volume (the step-4 check passed), and nothing we own
had detached it. We never observed whether the attachment would have returned:
our teardown destroyed the Machine 3.5 s later. A persistent drop of the
attachment record fits the same receipts. The parent's
hypothesis (the attachment is not yet visible right after clone) is inverted:
the attachment was visible first, then vanished from one read right after a
successful update.

Across both shard controllers, 1 of 41 disposable Volumes showed this. The
other 40 verified normally. Fly's reason for the null read is provider-internal
and cannot be observed from here. What we own is that `inspect` collapsed two
different facts into one terminal check:

- "no attachment reported" can be a transient provider read;
- "attached to another Machine" is a real ownership violation.

The bounded retry from 59b19ba00 covered only CLI rejections, not a successful
read with stale content.

Deeper rung: why could a single read decide this? The helper had no
re-observation contract for provider read lag, even though its own header
already documents Fly's burst-time inconsistency ("volume not found" 240 ms
after an attached GET). Above that is Fly's API consistency model, which is
third-party, so the ladder stops here.

Separate defect: in `DISPOSABLE_REAP` mode, `reap_volume` never resends DELETE
after attempt 1. It sets a placeholder `destroy_rc=1` and then logs it through
the same "volume destroy attempt N/6 rc=1 response=<empty>" path as a real
rejected DELETE. That made a successful teardown look like a failed destroy.
This is an observability bug only; the lifecycle decisions were already correct.

Archive searches: "Volume not attached to the exact owned Machine disposable
volume backup", "attached_machine_id null after volume update clone attach
transient", and "volume destroy attempt rc=1 response empty reap". Relatives
found: 2026-07-14-transient-volume-not-found-treated-as-fatal-clone-failure,
2026-10-16-volume-backup-status-used-unsupported-json-flag and
2026-09-09-clone-source-read-failure-entered-target-reconciliation. None is a
recurrence; this is new territory.

Golden references: claude-code-src, codex, openclaw and hermes-agent were
searched for an eventual-consistency re-read pattern. None has a cloud-volume
analog. The repo's own precedent, 2026-07-14, is to retry the transient class
and keep definitive errors fatal.

## Solution

`inspect` now re-observes only a null attachment, at most `SETTLE_READS=4`
more times. It uses the existing jittered `pause` (about 11–22 s per inspect).
The unchanged 60 s `bounded` deadline caps the total: a rejected-update replay
path can exceed it, which raises `Deadline` and fails closed with the intent kept. Each re-observation
repeats the full exact check: Machine mount, Volume identity and state, backup
field and registry row. An attachment to any other Machine now fails closed
immediately as "Volume attached to a different Machine". A null that persists
still fails as before, without a verified receipt. No update is replayed, and
the one-update fencing is unchanged.

`reap_volume` now logs reconcile-only passes as `volume destroy reconcile N/6
id=... state=<exact state> (DELETE not resent)`, in both the stderr and
diagnostic-log variants. Real DELETE attempts keep their existing rc/response
lines. One side effect: on a reconcile pass the diagnostic-log write now happens
after the exact lifecycle read, so a failed log write no longer masks an
already-terminal (0/74) outcome. Every other lifecycle decision is unchanged.

Regressions in the owning, deploy-registered suites (scripts/test.sh, cloudbench
gate):

- `cloudbench-disposable-volume.test.py`:
  - a persistent null (the captured run) is bounded and unverified;
  - a pre-update null re-observes, then does exactly one update;
  - hypothesis coverage: null, null, then attached verifies;
  - a foreign attachment fails closed with no re-read;

- `cloudbench-disposable-lifecycle.test.py`: reconcile passes never report
  `rc=1`.

All four were observed failing against origin/main and passing with the fix,
and the three suites passed 5 consecutive runs. While running the gate, I also repaired
`cloudbench-disposable-recovery.test.py`. On main it failed 4/8 because its
function extraction omitted `reconcile_stale_fleet_registries_full`, which
1dfebdb41 introduced.

At 10k agents this adds at most four extra exact GET pairs, and only for the
rare null read, about 1 in 41 clones here. There is no new shared state.

Status stays open. The local proof covers our boundary only. Whether Fly's
null read is transient is unproven, and outcome proof is pending: the next
live original600 run must show no attachment-mismatch INFRA_ERROR. If a null
persists through the bound, the private receipts now hold every re-read for
the next RCA. A Machine destroyed by someone else may keep reporting its
mounts; that case still fails closed, after up to about 22 s.

Taxonomy candidate for `other`: a provider read that is eventually consistent
being treated as definitive.

## Human feedback

The parent directed bounded re-observation in the existing owning code, not a
blind retry, with a genuinely different attached Machine still failing closed.

## Reusable lesson

Distinguish "provider reports nothing yet" from "provider reports a conflicting owner": re-observe the former within a bound and fail closed on the latter.
