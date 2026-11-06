---
id: 2026-11-03-native-cloud-reconciliation-missed-campaign-recovery
date: 2026-11-03
title: Native cleanup reconciliation rejected campaign membership and recovered release evidence
surface: harness
component: staged-deploy-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: single-fleet reconciliation required one detached controller and original lifecycle audit seal after native recovery produced a separate release seal
symptoms:
  - "native cleanup proof refused"
  - "controller_log"
  - "native audit seal"
  - "unsupported Fly agent version"
  - "unsupported proof layout"
tags:
  - deploy
  - campaign
  - cleanup
  - ownership
  - evidence
sources:
  - PR #1662
  - commit 3625eccd4952388c56e979c6a61045dff1c7804a
repro: python3 scripts/tests/deploy-test-cycle.test.py -q
status: open
---

## Problem

The cloud adapter routes smoke checks through the existing single-task campaign.
The native cleanup reconciler still expected one detached controller whose first
fleet contained every requested check. The failed full run instead owned fourteen
single-task parent fleets and one nested infrastructure canary. Its original
coordinator and adapter receipts correctly retained fourteen UNVERIFIED results.

Canonical recovery later released eight exact owners, preserving each original
failed lifecycle and its missing-runtime flags. Recovery wrote new native audit
seals, provider release epochs and captured runtime evidence. The old reconciler
could not represent that producer layout or distinguish the new release evidence
from the immutable historical failure projection. Six other owners remain blocked.

## Diagnosis

This is a branch-introduced reconciliation contract mismatch, not a change to the
benchmark outcomes. A single-fleet controller-handle proof cannot stand in for a
campaign's exact parent/canary closure. Replacing an original lifecycle seal or
missing-runtime flag would fabricate historical cleanup success.

Independent review of the first private candidate found missing shared campaign
cleanup and publication checks. Later review found missing native root-custody
checks, including the requirement that the allocated primary root is graded.
Each finding was reproduced by an atomic refusal control before correction.

## Solution

Add an explicit campaign proof layout while preserving the existing single-fleet
contract. Bind the original receipt, adapter, full owner, source, token and native
campaign root. Require the exact terminal job inventory, each job's first parent
handle, all owned participants, and existing shared transport, ticket, inventory,
cohort, publication acknowledgment and publisher-quiescence checks.

For a canonically recovered parent, verify the new native provider audit seals,
release epoch, retired registry, resource dispositions, captured runtime manifest
and every original file hash. Bind the exact guest acknowledgment and native V2
stack identity. Parse every allocated root's native custody, deleted/sealed tree,
complete provider-session release receipts and terminal payment snapshot using
the existing payment predicate. Keep retained Hub identities and transfer duties.

The overlay only permits a future launch when every participant is proved. It
never edits original receipts, lifecycle files, missing-runtime flags, results or
financial records, and grants no task or cleanup PASS. All eight actually released
owners pass the bounded saved-evidence replay. The whole actual campaign still
refuses the six unresolved owners; no canonical reconciliation has occurred.

The final reviewed replacement has SHA256
4fe031bf1e459372e0496e91fb11ff058ec952ff22c604d025ac3ba9f7ce931f.
Registered owning controls cover campaign membership, shared pending obligations,
publication, source/owner changes, incomplete capture, custody, provider release
and payment refusal. The parent ran the owning cycle suite after integration: 87 tests passed.
Native coverage and actual whole-campaign cleanup remain open.

## Human feedback

Keep deployment moving autonomously while preserving real failures and exact
owned resources. Infrastructure fixes do not authorize fabricated results,
financial settlement, evidence reconstruction or cleanup exceptions.

## Reusable lesson

A recovery producer may emit a new release record while preserving its original
failed execution projection. Validate the new record against exact membership and
all native cleanup authorities; never rewrite the old failure to make it fit.

## November 4 recurrence: next-source renewal after interrupted recovery

At `6be23a907897c68035471d5770a7c8cdb8b4c5e2`, the public reconcile
command refused renewal of the already validated round-37 smoke token
`7cf73e413dbf4046b8bdcec0441fe56a`: `a quiescent interrupted operation
token is required`. The cycle had legitimately refreshed its source and finished
quick validation, leaving quiescent TRIAGE in round 38. The original interrupted
receipt remained immutable, but its isolated-validation proof still named f66 as
the permitted next source. The token resolver required the *current* phase and
latest attempt to be interrupted, while fresh admission required the new source.
This was a reconciliation lifecycle defect, not a new benchmark failure.

The reviewed two-file correction (`0cac920b7d9e0cf5c6f9b6216af3b629d435e8b38a8c2dd690f73249d8c3a2ba`)
uses the existing public reconcile action only for an already reconciled exact
native-cloud token at quiescent TRIAGE. It revalidates the prior native proof,
requires every incoming proof field except `validation_source` to be identical,
and binds that source to the current state, plan and actual checkout. It then
replays the unchanged native validator. Only after all checks pass does it retain
the full prior entry in history and update next-source admission. Repeated
identical renewal makes no state change; newer receipts or changed proof bytes,
identity, confirmation, source or execution state refuse atomically.

A registered causal control reproduced the original public refusal after an
accepted interrupted proof, actual fixture-source change and quick attempt.
Four targeted owning methods then passed in 5.370 seconds, including renewal,
idempotence, nine atomic refusal variants, native-file tampering and the existing
full-request/debt guards. Independent review cleared the exact patch. The raw
round-37 receipts, native UNVERIFIED outcomes, old financial/archive obligations
and original clock remain unchanged; `credit_granted` and `cleanup_complete`
remain false. These controls grant no full-gate PASS or deployment completion.
The observed refusal and causal logs are retained under
`.context/preparation/6be-current/reconciliation/smoke.native.log` and
`/var/tmp/pr1662-6be-cloud-renewal/`.


## November 4 recurrence: clean full successor prevented original proof renewal

At `73104c463c1d307deafff032a24a96440d4a9160`, quiescent round-44 TRIAGE
renewal of original round-37 token `7cf73e413dbf4046b8bdcec0441fe56a`
failed with `native cleanup: original receipt superseded`. The later round-43
smoke request `1c1c93625efe40e38ca7ba1fb4871dd2` had genuinely completed its
full inventory and verified native cleanup. Its immutable request and receipt
contained the exact original-token/receipt isolation binding. The old renewal
required the original receipt to remain latest, while fresh admission still
required all preserved historical isolated-validation entries to name the next
source. Removing an old entry or substituting an unrelated failure was not used.

The private two-file correction has SHA256
`8345145844d0073466d6d3708a8a8b07a3cb4c53f9c8a5a20c13d19acadc686c`.
It admits only a strictly validated latest COMPLETE FULL native successor as an
alternative to the original-latest precondition: exact source/request/token,
full command/contract/environment/inventory, original isolation admission and
excluded resources, on-disk receipt, worker-result SHA, cleanup reference and
native evidence hashes. An incomplete, owned, cancelled, timed-out, foreign,
changed or newer unknown successor still refuses. Existing quiescent TRIAGE,
prior-proof replay, current-source binding and validation-source-only renewal
remain mandatory. It never treats a complete native FAIL as PASS.

The same registered control first reproduced the original refusal, then four
targeted methods passed in 4.305 seconds, including atomic successor/tamper
refusals and existing renewal controls. Read-only saved-evidence replay reproduced
the refusal on original code and accepted the candidate in memory against the
247-file round-37 proof and exact round-43 successor. Independent review cleared
the exact patch and matched all 265 replay-bound paths. The raw round-37 and
round-43 receipts, native FAIL/UNVERIFIED labels, debts and original clock remain
unchanged; historical `credit_granted` and `cleanup_complete` remain false.
No canonical reconciliation, new-source FULL coverage or full-gate PASS is
claimed. Evidence remains under `.context/preparation/731-current/reconciliation/`
and `/var/tmp/pr1662-731-clean-successor-renewal/`. This does not close the case.


## November 6 recurrence: relay refusal before any campaign dispatch

PR #1716 smoke source `7afb10b48266450397a12c99f3a5dc4a9d41f83e`
failed at `unsupported Fly agent version` after installing CLI 0.5.5 while the
relay correctly pinned 0.4.115. The original summary retained nine cancelled,
never-started jobs, empty runs and peak concurrency zero. All nine native
results remained UNVERIFIED. Reinstalling the pinned CLI repaired the executable
prerequisite, but the cleanup verifier rejected this pre-dispatch producer shape
at `unsupported proof layout`. Socket absence alone was insufficient custody:
the original broker had rejected version before authenticating/capturing its
peer, and the native cloud adapter had not requested its existing supervisor.

The correction captures authenticated Unix peer PID/UID/birth/socket and source
before version refusal, emits typed startup join evidence, and requests existing
owned native supervision for future attempts. A separate `campaign-startup-v1`
verifier requires exact zero-dispatch inventory, immutable original request,
receipt, result, source and owner bindings, no admitted routes/leases/fleets,
retired local owners and native publication closure. For historical startup only,
complete original official Fly bootstrap/PING/shutdown logs can establish the
same-boot exact agent PID; any current entry at that PID refuses. No missing
birth or supervisor sidecar is synthesized.

The publisher normally removes its owner file after joining its snapshot loop.
The verifier supports only the exact reviewed producer source hash, its retained
byte-identical script and empty stop marker, then consumes the inventory identity
already captured in the original relay authority and checks retirement. A present
conflicting owner always refuses; no owner file is recreated.

Seven registered `RelayStartupEvidence` cases cover the public reconcile path,
real Unix peers, actual native supervisor and refusal controls. Baseline fails
at unsupported layout/missing capture; after correction all seven pass. The
additional removed-owner regression fails before its correction and passes after.
Parent validation of the complete original 15-file proof used actual Git objects,
publication records, original Fly logs and current process checks without mocks;
it returned `credit_granted=false`. The independent reviewer found no remaining
blocking defect in the exact startup/removed-owner scope. Full smoke success and
production verification remain separate deploy obligations; this recurrence does
not close the older six unresolved owners or upgrade historical test results.


The first snapshot's healthy gates all passed, but integrating current main and
this prerequisite before their isolated workers finished correctly made the
coordinator attempt STALE. That boundary retains native receipts without
promoting its live failure IDs into triage. The public reconcile entrypoint
therefore still refused the exact cleanup proof as requiring an interrupted
token. The same startup-only verifier now also admits the unique latest exact
operation token at quiescent STALE, requiring the original frozen source,
executed/incomplete UNVERIFIED receipt and no running/live/cancelled work. It
replays the full unchanged proof and grants no credit. An eighth registered
causal test fails before and passes after; the complete owning cycle suite
passes 161 tests. Independent review found no blocker in this bounded branch.


### November 6 followup: dispatched controllers failed before allocation

The next exact native request passed relay startup and dispatched nine local
controllers. The protected shared warm source was still starting, so all
controllers ended before allocating guests or producing agent artifacts. Its
native supervisor joined an intentionally retained local Hub after leader exit,
correctly reporting orphaned children and causing the adapter to discard normal
collection. Every original task remains UNVERIFIED/INFRA_ERROR with no credit.
Provider readback later confirmed the warm source stopped; no remote resource
was modified to make it ready.

The reviewed campaign-preallocation-v1 proof binds the original null native
reference, full request/command/source/token, terminal job/owner inventory,
authenticated relay capture and retired processes, original native sidecar,
publication acknowledgment and sealed local/canonical audits proving zero owned
resources and no task artifacts. Historical source authority is explicitly
reconstructed from the original exact native --ref command and four pinned
producer source objects; no missing per-controller log ref is invented. Every
present foreign ref refuses, including after the monitor or masked by a later
matching ref. Future campaigns persist each actual controller command before
dispatch and validate that source directly. The complete original 143-file proof
validates without mocked boundaries and grants no task or source-execution PASS.

Native deploy campaigns now join only their request-scoped Hub through the
existing exact-owner termination protocol after all controllers, shared cleanup
and publication have ended, before their supervised leader exits. A real adopted
Hub reproduces the old orphan flag and passes after this change with no supervisor
TERM, unknown child or orphan. The existing 164-test owning cycle suite and eleven
targeted native cases pass in the integrated candidate. Raw setup/intermediate
failures, original sidecars and retained service custody remain preserved.
