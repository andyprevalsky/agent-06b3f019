---
id: 2026-09-09-inherited-script-snapshot-ownership
date: 2026-09-09
title: Nested controller inherited its parent's script-snapshot cleanup ownership
surface: infra
component: cloudbench-script-snapshot
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet snapshot entry trusted inherited owner mode without matching the sealed owner PID
symptoms:
  - "❌ script snapshot owner birth drifted from sealed identity"
  - "snapshot ownership error: snapshot ownership transferred to another live process"
  - "❌ infra canary preflight FAILED (exit=1) — refusing capability fleet (INFRA)"
  - "campaign cohort does not own this controller"
  - all Polar tasks terminalized INFRA_ERROR with no current run artifact produced
tags:
  - cloudbench
  - fleet
  - script-snapshot
  - nested-controller
  - process-identity
  - campaign-barrier
sources:
  - PR #1299
  - commit e9ce394585db709669f6bae68e578a85624bb434
  - commit fe99d86f6
  - commit 6e95c1e6e
  - commit 6b01c7483
  - fleet run 20260909-170812-4093151
  - fleet run 20260909-170832-4093685
  - fleet run capability-stability-20260910105116-2670724
  - fleet run 20261006-053308-448
  - commit f1e756cea51c1946ad80ea8904d88ca0547452ce
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: open
---

## Problem

What: a 10-task Polar capability fleet never provisioned and terminalized all
tasks as `INFRA_ERROR`, even though its automatic two-task infra canary passed
both probes. Where: the nested `run-bench-fleet` process entered the outer
controller's immutable script snapshot as a cleanup owner. Why: the exported
`CLOUDBENCH_SCRIPT_SNAPSHOT_OWNER_MODE=owner` crossed `bash`/`exec` process
boundaries while the sealed owner PID still named the outer controller. The
nested controller therefore armed an owner EXIT trap and failed after its
successful canary teardown.

The outer artifact recorded 0/10 passes, controller exit 1, 992 seconds, and
`no current run artifact produced` for every task. The nested canary artifact
recorded 2/2 passes, controller exit 0, and both clones destroyed. The next
outer output was exactly `❌ script snapshot owner birth drifted from sealed
identity`, followed by the preflight refusal.

## Diagnosis

Critical path: outer controller creates and adopts a sealed script snapshot →
`fleet_infra_canary_preflight` starts `run-fleet-infra-canary` in a new Bash
process → the wrapper execs another fleet controller while inheriting the
outer owner environment → the nested controller arms owner cleanup → both
infra probes pass and teardown completes → nested EXIT cleanup rejects its
different PID birth → preflight maps exit 1 to INFRA and refuses all Polar
provisioning.

Proof: the unchanged local repro
`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_nested_controller_borrows_parent_owned_script_snapshot`
failed with child PID 4109258, sealed PID 4109219, both in `owner` mode, and
`❌ script snapshot owner birth drifted from sealed identity`. A second run
started both processes in the same second and still failed: PID 4109535 differed
from sealed PID 4109497 while both `lstart` strings matched, so the helper
correctly reported `snapshot ownership transferred to another live process`.
The marker remained present and the exact parent later matched its own PID birth
and removed the snapshot. This confirms inherited ownership and rejects marker
mutation, one-process birth drift, and canary-task failure.

Problem: cleanup ownership is a process-local capability, but the controller
represented it as freely inherited environment state and trusted that duplicate
state at process entry. The deepest owned cause is a logical inconsistency in
the snapshot lifecycle contract: immutable bytes may be shared by synchronous
nested controls, while cleanup ownership must remain bound to one complete
PID-birth identity. This incident is a sibling of
`2026-09-09-provider-teardown-coupled-to-retired-hub-owner`, not a recurrence;
both require immutable process identity, but this boundary duplicated ownership
across a child rather than coupling teardown to a replacement Hub.

## Solution

`scripts/run-bench-fleet` now derives effective ownership at every snapshot
entry: an inherited `owner` role whose sealed PID differs from the current
controller becomes a synchronous borrower. Only the exact owner retains cleanup,
and borrowers fail closed if asked to detach beyond the owner's lifetime. The
token/PID/birth cleanup helper and its ownership guard remain unchanged.

The sealed snapshot now includes `run-fleet-infra-canary` and
`fleet_infra_sample.py`; preflight invokes that sealed wrapper, and the wrapper
resolves its sampler and nested fleet binary from the same immutable runtime
root. This removes the live-checkout side path rather than adding a canary-PID
exception.

The permanent regression holds a real parent owner open, re-enters its exact
snapshot from a distinct process with inherited owner variables, requires the
child to exit 0 without mutating or deleting the bundle, verifies the canary
control files are sealed, then requires the parent owner to delete the bundle.
It failed before the production fix and passes unchanged afterward. The full
cloudbench dependency suite reports 250 passing tests; the fleet canary
structural and hermetic multi-workstream suites also pass.

At 10,000 agents this remains O(1) per fleet controller entry: one local PID
comparison, no per-agent query, channel, poller, lock, provider call, or shared
mutable row. Nested canaries share one read-only sealed bundle while one process
retains cleanup ownership.

## Recurrence on 2026-09-10

Capability proof `capability-stability-20260910105116-2670724` reached failed
canary cleanup and again printed
`script snapshot owner birth drifted from sealed identity`. This time the
nested-owner normalization was already present; the remaining cleanup path
still re-read its own formatted birth at EXIT and allowed that fresh value to
override the PID birth sealed in the owner marker and environment.

The unchanged pre-fix command was:

`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_script_snapshot_cleanup_uses_sealed_self_identity`.

It held marker PID, token, and sealed birth constant, changed only the fresh
EXIT-time `ps` value to `drifted-birth`, and failed before invoking guarded
cleanup. After the fix, NDJSON recorded the intentional mismatch while the
helper received the sealed birth, matched the exact marker/caller PID, and
removed the snapshot.

The first implementation removed every helper-side birth probe. The full
dependency suite then failed
`test_script_snapshot_unknown_transferee_identity_never_authorizes_deletion`:
with a live claimant whose second identity probe was unreadable, cleanup
returned `transferred`. Instrumentation proved the only probe targeted the
claimant and succeeded because the current observer probe had been removed.
The corrected fix trusts sealed identity only for exact self cleanup. Claim,
arm, transfer, and handoff boundaries still verify current PID birth, and an
unknown transferee remains fail-closed. The focused four-test set and complete
lifecycle suite pass.

This is a recurrence because the earlier guard established sealed PID-birth
ownership but left one second source of self identity at cleanup. At 10,000
agents the correction remains O(1) per snapshot boundary with no provider call,
global scan, shared lock, channel, subscription, or fan-in.

## Human feedback

The user required runtime evidence plus an unchanged red/green owning-boundary
repro, a general nested-control ownership fix that preserves immutable execution
and the ownership guard, permanent coverage in the existing cloudbench/fleet
path, no paid fleet rerun, removal of all debug instrumentation, and no commit
or push. The parent owns the exact live fleet outcome proof.

For the recurrence, the user required exact live evidence, a deterministic
birth-drift regression, preservation of unknown-transferee fail-closed safety,
no benchmark/timeout/concurrency changes, full lifecycle verification, and
instrumentation retention until the exact acceptance proof is confirmed.

## Reusable lesson

Derive process-local cleanup ownership from the complete sealed identity at every child entry; never inherit ownership merely because immutable bytes are shared.

## Nested fleet-token recurrence (PR #1299)

Proof `capability-stability-20260910230955-44684` failed before provisioning
with `refusing pre-existing fleet audit owner path`. Its slice had an explicit
owner token for final receipt verification. The fresh mandatory canary inherited
that token through the preflight helper and attempted to create the parent's
already-owned audit directory.

The helper now allocates a fresh token for each nested canary controller while
leaving the parent's environment unchanged. Snapshot borrowing and the shared
check/run/stamp lock remain unchanged. The existing concurrent-preflight test
now passes two different parent tokens and requires the one serialized child
to receive a valid identity distinct from both. It failed before the fix and
the complete canary and stability-proof suites pass afterwards. Evidence:
`.context/acceptance/nested-canary-owner-{repro,fixed}.log` and
`.context/acceptance/stability-proof-final.log`. Both suites are permanent
`/deploy` controller gates. UUID allocation is constant work per nested
controller and introduces no provider query or shared coordination.

Adversarial review found the matching evidence-selection boundary: the nested
canary prints its own execution provenance after the parent. Selecting the last
line would therefore reject a successful parent against the child's receipt.
The proof now selects exactly one receipt matching the expected parent token
and workspace before applying all existing lifecycle, audit, and outcome
checks. Missing or ambiguous ownership remains infrastructure failure. The
offline fixture reproduces parent provenance followed by a distinct canary,
and separately rejects two candidates claiming the parent identity. The first
fixture failed before the fix; the complete proof suite passes afterwards:
`.context/acceptance/nested-canary-provenance-{repro,fixed}.log`. Selection is
linear in the controller log's provenance entries and performs no provider IO.

## Campaign-slot recurrence on 2026-10-05

The strict cached campaign `campaign-20261006-053209-82156` reached its shared
two-task substrate canary while its other controllers waited on the existing
check/run/stamp transaction. Its first terminal error was a separate Hub
publication timeout in `r031-j0031`. The campaign was canceled normally with
zero benchmark executions: one failed outer controller, 49 canceled controllers,
and no cohort release. This recurrence does not assign that Hub failure to the
canary.

Read-only inspection found an additional inherited parent identity. The
preflight helper copied `RUN_BENCH_CAMPAIGN_BARRIER_DIR`,
`RUN_BENCH_CAMPAIGN_COHORT`, and `RUN_BENCH_CAMPAIGN_JOB_ID` into the nested
canary. The campaign manifest assigned `r005-j0005` to outer PID 82290, while
its nested canary was PID 448 in run `20261006-053308-448`. Once that canary
reached ordinary stack readiness, the real campaign rendezvous would reject its
different PID. This is an upcoming boundary: the actual canceled canary retained
only cloning states, two allocation epochs, and no task `run.json`; it never
called that rendezvous. The retained inventory diagnostics show 27 successful
refreshes. The shared transaction lock, width two, and 3600-second stamp TTL
were operating as designed, with no evidence of a publisher failure or lock
self-deadlock.

The bounded replay used the unchanged production preflight helper and campaign
rendezvous with a real parent lock and a manifest binding the parent PID. Its
distinct child exited 1 in 0.053 seconds with the exact
`campaign cohort does not own this controller` rejection and no PASS stamp or
parent ready marker. The ordinary-canary inverse exited 0 and stamped PASS in
0.053 seconds. Neither replay used a provider, service, or model. Private
source-bound receipts are under
`.context/deploy-runs/20261006-024302-65153/canary-pipeline-rca/`.

The helper now removes only those three campaign rendezvous keys from its
child environment. The parent's campaign slot remains intact. Shared inventory,
inherited proxies, immutable snapshot borrowing, the fresh nested fleet owner,
and the distinct nested controller lock are preserved. The nested substrate
check must finish before the outer controller can join its campaign; it cannot
participate in that outer slot itself. This is another instance of inherited
parent authority crossing the same nested-controller boundary, so the evidence
extends this case rather than creating a duplicate.

The existing permanent `scripts/tests/fleet-infra-canary.test.sh` now exercises
that production-helper/rendezvous path. The same owning control failed before
the fix (exit 1, 0.831 seconds); the full gate passed after it (exit 0, 1.625
seconds). It also checks the ordinary inverse, preserved inventory/proxy values,
fresh nested owner and lock, unchanged parent identity, wrong-controller
rejection, and correct-parent acceptance. Existing serialization, failure-status,
and crashed-helper lock controls remain unchanged. No barrier criterion,
deadline, concurrency, task behavior, or resource cleanup policy changed.

The final native 32-scenario proof and 82% composite coverage remain separate
executed receipts on `f1e756cea`. The native fixture's only fleet execution
entry always supplies `CLOUDBENCH_FAKE_DIR`, whose unchanged guard skips this
substrate preflight. The changed helper is verified by its owning offline gate;
the recorded native and funded successes are retained with explicit dependency
hash differences rather than relabeled as fresh full runs. A new successful
cached campaign is still required for its own acceptance credit.


## Recurrence — 2026-10-06 nested canary inherited its caller's seed proof

CodeRabbit4201671720 found another parent-scoped capability crossing the same
nested-controller boundary. The preflight correctly removed outer cohort/job
identity and created a fresh nested owner, but omitted the newly introduced
`CLOUDBENCH_CAMPAIGN_SEED_PROOF`. The nested fleet therefore entered the actual
seed-consumption branch while its required barrier/job variables had already
been removed. The first bad handoff is this incomplete environment isolation;
the seed consumer's required-membership checks remain correct.

The existing `fleet-infra-canary.test.sh` owning control now advertises the
outer proof and executes the actual fleet seed-consumption branch before its
unchanged rendezvous checks. Frozen5c1 failed (exit1,1.158s) at `nested controller
rejected outer campaign identity`; the same complete quick suite passed after
one scrub-list entry (exit0,3.689s). It verifies campaign and standalone nested
checks, no inherited cohort/proof/group fields, unchanged parent identity,
preserved inventory/proxy values, fresh nested owner, serialization, original
failure status, wrong-PID rejection and correct-parent acceptance. Existing
assertions remain intact. The outer control processes were reaped and their
captured births are absent. No providers were called.

The earlier fix handled known campaign fields but did not cover the later seed
proof field; this is a recurrence of incomplete parent-authority isolation,
not a new case or a justification to weaken proof validation. Literal and
behavioral archive searches and immutable RED/GREEN hashes are in
`.context/fresh-claude-grouped50-20261006/final-review-seed-proof-packet/`.
The existing `/deploy` pointer and `scripts/test.sh` already run this quick
suite. This private correction changes no task, deadline, source snapshot,
shared inventory ownership or cleanup contract. Composed deploy and any real
campaign outcome remain separate qualification, so the case remains open.
