---
id: 2026-10-07-completed-absent-primary-blocked-guest-reconnect
date: 2026-10-07
title: Exact recovery rejected a completed absent or destroyed primary before reconnecting remaining guests
surface: harness
component: run-bench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: fleet_recovery_reconnect_guest_shutdowns required native presence before reading completed originals, including an exact destroyed tombstone excluded from current inventory
symptoms:
  - completed exact owned Machine is absent or returns a destroyed tombstone excluded from current inventory
  - complete original seal and guest shutdown ACK remain under an owned registry record
  - recovery stops before reconnecting remaining exact guests
tags:
  - cloudbench
  - exact-owner-recovery
  - completed-originals
  - quarantine
  - native-absence
sources:
  - commit e16eb1d2d66097f4da2268a0e2651cca78d71d0c
  - fleet run 20261007-224256-41245
  - memory:completed-guest-recovery.private/original-binding.safe.json
  - memory:completed-guest-recovery.private/red.safe.json
  - commit 200fe31bd61df60bba88512e2d571a2481dd8d30
  - memory:completed-guest-recovery.private/tombstone-red-v2.safe.json
  - memory:completed-guest-recovery.private/original-tombstone-binding.safe.json
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_recovery_consumes_runtime_receipt_completed_absent_primary
status: mitigated
---

## Problem

Original Control 11 retained fifty task outputs and a failed controller lifecycle.
The grep-agent-trajectories-isolation primary was positively absent from native
inventory while its exact original allocation remained registered as owned.
Its original run shutdown ACK, ordinal runtime owner, complete stopped-stack
manifest and byte-identical canonical result remained intact. Supported recovery
stopped at the native-presence reconnect guard before reaching remaining guests.
The retained exact native status later proved exit 0 with state destroyed and
the exact clone name; current app inventory excluded that primary. Inventory
absence must not be mistaken for the status command's exact-not-found result.

At the parent observation there were seven started owned Machines and nine
remaining Volumes. The frozen catalogue scan found 49 exact original run ACKs,
50 matching ordinal runtime owners and empty worker ledgers, and 48 owner-bound
manifest/stopped-services files. These aggregate counts describe their own
scopes; they do not replace per-file seal validation or native resource release.
The separate parent all-guest native/process receipt positively established
no remaining original model callers. Original publication, archive and resource
ownership still required their own cleanup.

The original source and first-image epoch 1791412280 remain immutable. Its
whole-run deadline was 1791415880. Original lifecycle status remains failed,
controller exit remains 1, and acceptance credit remains zero. A native cleanup
runner's exit 0 records that runner's completion.

## Diagnosis

The planner correctly retained the registered primary as a current guest.
The next consumer called registry_machine_details, which already distinguishes
exact positive native absence (1) from unreadable or unsafe state (2).
The reconnect guard rejected both statuses before considering the completed
original ACK and seal. The existing sealed Machine-only retirement exception
requires its own prior intent and retained-volume receipt; it does not describe
this original state.

The first partial repair, commit 200fe31, recognized only exact native status 1.
Supported recovery attempt 02 still failed in 6.45 seconds on the actual status
0/destroyed representation, reaching the existing unsafe-state guard. The
retained original status was parsed again by the actual production parser:
state destroyed, exact clone name, and no corresponding current inventory ID.
Its status SHA256 is
384cb41c90b7feec62370ed0534ea86250536d24409895f25a9e1685acfffaf2.
The parent then captured its exact config once, SHA256
7f9df411435f3440eed84680e51502bfa11eb927497a02d297404ff9387cea29.
This is a native representation gap, not a timeout or evidence-publication
failure. The partial repair and unsuccessful recovery receipt remain intact.

The first incorrect predicate is therefore mandatory native presence for every
still-registered guest. Allocation bookkeeping can outlive a positively absent
native Machine. Its completed scope must be recognized from intact originals
without borrowing authority from unrelated guests. The native absence alone
does not establish why the Machine disappeared, a driver crash, missing evidence
or full resource release.

The original registry also has cleanup_policy=retain with guest and runtime
latches. Normal exact recovery admits that quarantined phase before the ACK
consumer changes policy. The existing sealed retirement validator requires reap
for retirement, so calling it unchanged here would reproduce a second admission
error. Recognition and permission to reap are separate statements.

The permanent owning control runs the actual extracted planner, reconnect loop,
quarantine-state reader and normal ACK/latch consumer. It reuses the existing
complete-original fixture and pure result/provenance builders. Exact native
status parser and exact config reader use a local native transport boundary;
the remaining stopped guest also reaches configuration. No paid,
database or model operations participate. The main positive case has the actual
retain policy and both latches. A second positive retains reap compatibility.
The remaining exact guest must reach configuration, and every original authority,
task, seal and failed outcome byte is preserved. Only the unchanged normal ACK
consumer may change policy and discharge the guest latch.

The first frozen test SHA256 was
3de73b4863b6cc1145f34bf74f9ff68a1b0465622f80990b03c6e2a25dda90de.
The unchanged command, in an activated matching Python 3.11.9 venv, was:

~~~bash
python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k exact_recovery_consumes_runtime_receipt_completed_absent_primary -rA
~~~

Original e16 runtime produced 2 failed positives and 12 passed refusal controls
in 3.14 seconds. The same test bytes and command passed all 14 in 1.97 seconds
on the candidate. Controls cover unreadable native status, missing or child-only
ACK, foreign owner/source/index, pending capture, worker ownership, corrupt or
linked sealed bytes, canonical result mismatch and pool scope. They leave
authority and original files unchanged.

A read-only replay of the candidate's recognition mode on the actual original
grep task passed under retain. All 213 captured original registry, audit and
task file hashes remained unchanged. Its private receipt SHA256 is
1a7a706127332858fc91121f0d7bef1a25560acbf02dc0ecec7a02947b1a0a9e.
It performs no native operation and grants zero proof credit.

The refined frozen test SHA256 is
617984c756bc9dd15bc53f68cd1d4f41137f0492c01076b0d01145eae07d7f89.
The same owning command on partial 200fe31 produced one failed destroyed
positive and 21 passed controls in 7.65 seconds; the identical test passed all
22 in 6.22 seconds on the refinement. The added exact transport controls reject
foreign tombstone name, run token, source REF or patch, mounted Volume, an ID
still present in native inventory, and unreadable config. The parent independently
ran the normal selection: 22 passed in 6.92 seconds.

Read-only recognition of the actual original with the retained destroyed
status/config/inventory binding passed under retain. All 217 captured original
registry, audit, task and native-packet file hashes remained unchanged. Receipt
SHA256 is b3628a826e0a99c556ddb448d7b22bcd3335f982a0b832b50dfbc06d8efaa151.
It establishes exact completed-scope recognition, with no native operation,
model/database call, retirement authority or benchmark credit.

Archive searches included "recovery missing registry retired Machine",
"completed task originals block active guest recovery",
"absent completed primary guest reconnect sealed ACK" and
"retain quarantine original seal native not found recovery".
The October 7 retired-output planner case and mixed-cohort forensic case are
relatives: they concern entries already removed from the active registry.
This failure is the subsequent reconnect consumer's still-registered,
positively absent completed primary. The September 29 runner-receipt case
requires whole-guest evidence, and the October 6 forensic-ordering case separates
archive readiness from native release; those protections remain authoritative.

## Solution

Only a fresh guest with exact native status 1, or status 0/destroyed with the
exact clone name, enters completed-original recognition. The caller uses the
existing sealed Machine validator's binding
function in a new explicit read-only mode. It keeps the original app, owner,
run, catalogue ordinal, runtime token, source files, complete stopped-stack
manifest, clean cleanup token, required backend/worker files, canonical result,
task matrix, mode and execution-provenance validation. Its additional joins
require the exact by-Machine index and expected-fresh primary source intent,
an original source outside the recorded allocation tree, and the exact parent
run ACK. A child-token receipt alone cannot qualify.

For a destroyed tombstone, its current exact-ID config must join the original
runtime token, provenance REF and normalized patch hash, and sole original
Volume mount. Current bounded native app inventory must omit that ID. These
additional read-only joins cannot qualify a live, replaced or foreign scope.

The matched task, clone, Volume and output must equal the already validated
plan. Native unreadable status and pool guests stay on their existing refusal
paths. Recognition writes no intent or receipt, changes no policy or latch,
removes no ledger or audit record, and retires no resource. It simply skips
reconnecting that completed absent primary. Default binding and every retirement
command still require reap. Normal guest cleanup, runtime verification, exact
Machine/Volume reaper, final audit and owner removal remain responsible for
actual closure.

The supported maintenance CLI creates an immutable bundle from the newly
invoked checkout before argument parsing. Its selected helper is that new
caller's bundle; the failed owner's captured guest source remains unchanged.
A native --help invocation using the existing entry hook proved byte equality
for controller, helper and result/provenance modules, then exited 0, joined its
native process and released its own snapshot. Private selection receipt SHA256:
a18c6f018793fc60bf0f34343bcafdb98b87bb4e79298109158eaf1e0e81febd.
No helper subcommand or original snapshot rewrite is required.

Before the partial commit, the normal related selector passed 51 cases in
29.49 seconds, including original
runtime-receipt, retired-mapping, child-ACK and snapshot contracts. The existing
sealed Machine-only retirement runner passed 26 controls and retained its
default receipt bounds; the refined helper reran those same 26 successfully.
After partial 200fe31 was committed, the refined related selection recorded
58 passes and one refusal in 42.13 seconds. The pre-service preservation fixture
bound immutable git HEAD 200fe31, whose changed full controller recipe lacked
phase registration. Its unchanged production attestation guard correctly
refused that source fingerprint. With the existing fixture source override
bound to reviewed original ccc4, both unchanged pre-service controls passed in
5.20 seconds. That proves original-source compatibility, not qualification of
the new default HEAD. The original failed command and source-bound diagnostic
receipts remain preserved. The actual immutable candidate recipe is
77b2cf34137ab2fe4feda08338e9b7123f5dbeed4eedff88c6f39752ae4329aa:
38 of 39 inputs are unchanged from the reviewed original; only the full
controller input changes. Root independently reviewed that reconnect-only delta
outside the unchanged boot/index paths and certified only the existing
before-stack-launch and agent-network-index-bootstrap phases. Its receipt
SHA256 is f6999e60bc6223d0b1b916771b8c13c116b5b88e4321befce074bf06964f2bfe.
Only that exact fingerprint is registered in the existing policy, preserving
all prior entries and predicates. After runtime and policy were committed
together as ef4401d10, the identical default related command passed all 59
controls in 36.23 seconds, with no fixture override. Its preserved log SHA256
is a6857c80981c07b92010a80f52faaa69954c11525915ff5ec7701de049998bf8.
This includes both pre-service preservation controls, the 22 reconnect controls,
child-ACK and snapshot contracts. An uncommitted policy cannot satisfy the
trusted committed-byte check.

The existing benchmark-live-results deploy selector
already discovers the new exact_recovery_consumes_runtime_receipt cases.
No new runner, acceptance gate, polling loop, task window or production timer
was introduced.

Read-only local reference comparison: OpenClaw
src/process/supervisor/supervisor.ts:113 retains admitted scopes until their
cleanup completes; Hermes tools/process_registry.py:700 positively ends a
recovered owner while retaining finished history and guarding PID reuse;
Claude Code src/tasks/LocalShellTask/LocalShellTask.tsx:222 runs flushAndCleanup
before terminal task state. These support separate lifetime and retained
evidence responsibilities. None implements Rose's Fly/native seal join.
The local Codex snapshot was absent; no reference fetch or Codex behavior is
claimed.

This reuses the existing bounded local validator only for remaining registered
absent or destroyed primaries during failed-owner recovery. Its existing catalogue/audit
scan is repeated per such primary; no linear ten-thousand-task scaling claim
is made. It adds no provider calls, execution-path work or concurrency.
Runtime and the 22 owning controls received the parent's independent source
review. Its supported recovery attempt 03 then consumed all fifty genuine
original run ACKs through the normal consumer and cleared the guest latch.
It recaptured the second unsealed guest's normal runtime bundle and ended
runtime-incomplete with 49 sealed originals; the remaining Minted original has
no canonical run/seal. That separate original-volume forensic archive and
resource reaper remain the parent's work. Status remains mitigated pending
final independent review and actual remaining closure.
Local proof and read-only original validation supply
no fresh LIVE outcome, benchmark credit or full-release claim.

## Human feedback

Root required an owning correction in a separate workspace, faithful retain
quarantine, unchanged RED/GREEN controls, exact current native absence,
source-compatible immutable helper selection and preserved originals. Parent
owns recovery mutations. User instructions preserve all hard execution/E2E
budgets, require positive caller/resource closure at their actual scopes and
prohibit turning isolated infrastructure failure into a cancellation of healthy
tasks. Freedom remains protected.

## Reusable lesson

Recognize completed original evidence separately from native reconnect and
reap authority; a positively absent exact primary must not block recovery of
remaining owned guests.
