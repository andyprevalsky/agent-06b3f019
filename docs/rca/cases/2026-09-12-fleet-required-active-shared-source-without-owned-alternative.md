---
id: 2026-09-12-fleet-required-active-shared-source-without-owned-alternative
date: 2026-09-12
title: Fleet admission required the active shared source without an independently owned alternative
surface: infra
component: cloudbench-fleet-source-selection
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: fleet source selection resolved only the global cloudbench-warm identity before checking stopped state
symptoms:
  - shared warm source remains started through all 60 stopped-state checks
  - fleet aborts before initial capacity reservation or task clone allocation
  - an existing snapshot override cannot select a different source machine and volume
  - could not persist provider ID and volume; name ownership remains for teardown
  - owned fleet machine has no durable exact volume attribution; retaining record
tags:
  - cloudbench
  - immutable-source
  - ownership
  - preallocation
  - source-provenance
sources:
  - PR #1299
  - commit ed339ffe4ca40f2cd5b173996791607921f3f381
  - fleet run 20260911-200800-39650
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_private_fleet_source_avoids_active_shared_warm
status: open
---

## Problem

Proof 15 exhausted 60 checks waiting for the shared source to become stopped.
It aborted before initial capacity reservation and task clone allocation: zero
task roots and zero accepted slices. Exact owner cleanup was verified. The
protected shared machine `683e47df5094d8` remained started during a later bounded
read. Retained SSH activity and its age do not establish who owns that activity,
whether maintenance is progressing, or authority to stop it.

The stopped-source guard behaved correctly. The missing capability was selecting
an independently owned immutable base while that shared source was unavailable.
This repair does not weaken readiness or reinterpret the shared source as stale.
Private evidence includes `proof15-startup-cleanup-independent-review.json`,
`proof15-warm-status.private.json`, and `proof15-warm-recent.private.log` under
`.context/acceptance/`.

## Diagnosis

The critical path is source selection → stopped/parked validation → exact volume
snapshot selection → dependency proof → initial clone admission. Source selection
hardcoded the shared warm name and volume. `CLOUDBENCH_SNAPSHOT_ID` selected a
snapshot only after shared-source readiness; it did not select a different base.
The pool provisioning path uses the same prerequisite. The per-task `--machine`
option selects a task target, so it is not a fleet-source override.

The permanent local reproduction extracts the actual owning source-selection,
stopped-state, and dependency-preflight functions. Provider reads return a started
shared source and a separate stopped, owned source with a completed snapshot.
The original code still reaches all 60 stopped-state checks and rejects the run.
Only sleeps and provider/maintenance boundaries are replaced; every provider
command and maintenance invocation is recorded. No resource is allocated.
The normal stopped shared-source control passes.

The first run of `agents/venv/bin/python -m pytest -q
agents/benchmarks/cloudbench_dependency_sync_test.py -k private_fleet_source`
recorded one failure and 12 controls passing in 3.04 seconds. The unchanged
registered benchmark blackbox reproduced the same failure. Final source passes
the same selection assertions plus five additional owning controls: 18 cases in
3.62 seconds. Receipts are `private-source-permanent-red.log`,
`private-source-blackbox-red.log`, and `private-source-permanent-green.log` under
`.context/acceptance/`.

Archive searches were `warm source must be stopped before fleet provisioning`
and `shared warm source blocks immutable snapshot independent fleet`. The July 13
shared-source deletion case is an architectural relative; no deletion occurred
here. The July 18 direct-warm entrypoint and September 11 workspace-dependency
refresh cases address different boundaries and their protections remain intact.
The completed per-bench isolation plan describes per-task ownership but no
independent source manifest. All-branch history and the 50 most recent open PR
file sets were inspected. The other matching fleet patch, PR 1210, changes locks
and cleanup behavior, not this source-selection boundary; it was not adopted.

## Solution

Add the explicit `CLOUDBENCH_SOURCE_MANIFEST` option described in the
[private-source guide](../../cloudbench-private-source.md). Reuse the existing
immutable-file publisher, machine/volume readiness validator, completed-snapshot
selector, refreshed inventory index, ownership registry, and clone topology.
The manifest names the exact native machine instance, owned volume, completed
snapshot, region, image digest, installed dependency proof and owner metadata.
It also identifies both shared resources that must remain protected.

The controller captures one canonical immutable file before allocation. Its
digest scopes the pool and is recorded in execution provenance and both durable
owner records. Registry and audit copies must agree during recovery. Source
selection does not reread the mutable caller path. The helper is included in the
immutable controller script snapshot and runs from that snapshot. Clone retries
check the selected native instance, stopped state and storage readiness using the
existing inventory index. Installed dependency checks on actual guests remain
mandatory. Private dependency drift fails closed without shared maintenance.

Both bases are excluded from provider mutation, pool claim and cleanup. Review
controls caught and reproduced two candidate admission gaps before their fixes:
a protected machine could enter a contaminated pool, and an unrelated machine
could claim the protected source volume. Both now fail before claim publication;
an unrelated machine with an unrelated child volume still succeeds. A separate
unchanged regression first failed recovery of a captured private registry with
zero allocations. Its bound manifest now supplies the external source identity
without inventing clone ownership. Missing or changed source proofs still fail
closed. Supporting logs are `private-source-pool-red.log`,
`private-source-pool-volume-red.log`, and `private-source-unallocated-red.log`.

At 10,000 agents this adds no per-agent source inventory request, shared lease,
refresh queue or provider retry. The initial source verification performs bounded
inventory/snapshot reads once per fleet; per-clone admission uses the existing
indexed fields. Source preparation and retirement remain outside fleet cleanup
under the source owner's separate lifecycle. No task definition, evaluator,
concurrency, timeout, readiness bound or default shared behavior changes.

Final owning blackbox invocation passes; 43 source/default/recovery/provenance
checks pass in 24.43 seconds. Ruff, shell syntax and diff checks pass. Logs are
`private-source-blackbox-green.log`, `private-source-compatibility.log`, and
`private-source-lint.log`. One pre-existing structural test was aligned with the
already committed guarded maintenance cleanup spelling; its production behavior
was unchanged. Independent adversarial review approved the source and documentation
and reran all 18 private-source cases successfully in 3.73 seconds. Fresh full
validation remains pending. The review receipt is
`.context/acceptance/private-source-independent-review.json`.

The offline proof establishes source-selection and ownership behavior. No paid
fleet or source preparation was run by this RCA agent. The real private source,
preallocation, full task outcomes, teardown and ten sequential ten-task slices
remain to be verified; this case stays open until those gates are complete.

### Proof 16: source metadata did not survive the ownership lifecycle

The next real attempt, `capability-stability-20260912185727-5872`, selected the
owned source correctly but failed its default two-clone infrastructure canary
before starting any benchmark. Provider creation returned exact machine/volume
pairs, while both durable clone records remained name-only. Cleanup retained
the resources rather than claiming unproven volume ownership. This contributes
zero accepted slices and zero benchmark outcomes.

The first bad boundary was `fleet_audit_update_registry_clone`: its exact legacy
metadata key set rejected the newly persisted `source_manifest_sha256` field.
The earlier source-selection and recovery tests did not exercise promotion of
an actual private-source clone through this consumer. A sibling terminal audit
rewrite accepted the digest but omitted it from the rewritten metadata.

Archive searches used `could not persist provider ID volume attribution` and
`fleet clone ownership journal machine volume startup`. This is a regression
in the source-binding lifecycle introduced by this case's source capability;
the previous clone-source and migration ownership cases are relatives.

The local reproduction invokes the actual ownership functions against copies
of the failed run's registry and audit. Valid private-source metadata returns
exit 1 without publishing an identity; removing only the optional digest in a
legacy control returns exit 0 and publishes the same verified identity. A
separate copied terminal audit reproduces loss of the digest during successful
terminal publication. The latter fixture assumes completed cleanup only to
reach that publication boundary; it is not evidence of live resource cleanup.
Receipts are under `.context/acceptance/proof16-registry-source-rca/`.

The repair accepts only the documented optional metadata field, verifies the
original registry/audit digest and identical bounded regular manifest files
through the canonical source schema, and preserves that digest when publishing
terminal metadata. Nonblocking opens reject FIFOs without hanging ownership
publication. Legacy owners remain supported; owned workers still derive from
their own primary without falsely requiring every parent to be the base source.

The unchanged permanent test command, `agents/venv/bin/python -m pytest -q
agents/benchmarks/cloudbench_dependency_sync_test.py -k
'private_fleet_source_identity or private_fleet_source_terminal'`, records five
failures and twenty passing controls against the original controller, then all
25 passing in 8.63 seconds after the fix. The original controller is supplied
using `CLOUDBENCH_FLEET_SCRIPT_UNDER_TEST`. The adjacent source, audit-WAL crash
recovery and migrated-registry terminalization tests pass all 47 cases in
15.33 seconds. The existing registered private-source blackbox gate includes
the new cases. Independent review, Ruff, shell syntax and diff checks pass.

Independent provider reads bound the exact reserved names, native machine
instances, mounts and reciprocal volume attachments. Both machines were stopped
with those guards. The exact recovery command correctly refused the old
name-only records; no guard was relaxed. Fresh reads reconfirmed the stopped
native instances, sole mounts and exact volume identities. The fixed ownership
writer then durably promoted the verified pairs. The canonical
`--recover-stale-owner` command completed with exit 0, retired both pairs and
sealed the original audit. Receipts are under
`.context/acceptance/proof16-canary-retirement/`. This repairs cleanup of the
failed attempt; it does not change that attempt's outcome. The full Linux
controller checks and ten-slice live proof remain pending, so this case stays
open.

### Proof 17: source ownership completed; boot payload rejected

The full controller gate at commit
`0e0709d8d21fcbf7974c57f7a40075b5cc818e4a` completed with exit 0. Its Linux
controller scenarios and 183 Python checks passed, including the private-source
regressions. Native process exit and the durable Linux command exit agreed;
the source snapshot and final log hashes are recorded in
`.context/acceptance/proof17-controller.json`. This is the current controller
gate, not a claim that all thirteen earlier core gates reran at this commit.

The next real attempt, `capability-stability-20260912193727-17967`, cloned both
canary machines from the same private source, promoted their exact identities,
and completed canonical provider teardown. Independent reads verified both
native machine instances destroyed and absent from successful inventory, and
both exact volumes unattached in provider-retained `pending_destroy` state.
Local and shared terminal audits agree, retain the original source digest, and
have no remaining ownership registry. The private source remains stopped and
unchanged; the foreign shared source was only observed. The exact proof-owned
Hub was subsequently retired through its canonical owner receipt.

No benchmark started: the existing boot guard rejected a 1,053,180-byte payload
against its unchanged 900,000-byte ceiling before guest launch. This separate
transport failure leaves the attempt failed with zero accepted slices. Its
failed lifecycle and summary were preserved. Independent cleanup and Hub
retirement receipts are under `.context/acceptance/proof17-cleanup-independent/`
and `.context/acceptance/proof17-hub-retirement.json`. The live ownership path is
now confirmed, while the requested ten consecutive ten-task slices remain open.

### Proof 19: guest recovery retained a pre-source metadata parser

Proof 19 reached two accepted ten-task slices at unchanged commit
`891eadf921d6572ce9a4a821a67b139323549b0e`. Battery clamshell sleep interrupted
the third slice's local controller; that attempt remains failed with eight
`NORESULT` outcomes and no valid ten-slice streak. The independent native power,
inventory and guest chronology is retained under
`.context/acceptance/proof19-host-interruption/independent-review/`. This source
parser repair does not repair or reclassify that host interruption.

Canonical exact recovery then exposed another consumer of the private-source
record. Owner `9d851b4e105e4253a952218994780080` had the captured source digest
and both immutable source manifests, but `fleet_registry_build_guest_recovery_plan`
rejected `source_manifest_sha256` as `noncanonical recovery metadata` before
building any guest mapping. The runtime log is preserved at
`.context/acceptance/proof19-recovery-source-rca/runtime-before.private.log`.

Archive searches were `noncanonical recovery metadata source_manifest_sha256`
and `private source registry allowlist recovery manifest`. The previous clone
ownership case is a relative; this is a recurrence of this case's private-source
lifecycle gap. Proof 16 updated clone identity promotion and terminal publication,
but left the guest plan parser's independent legacy field allowlist unchanged.
The earlier private-source recovery regression stopped after source resolution;
it did not execute the downstream guest plan builder. Existing guest mapping
fixtures exercised only legacy metadata. The actual writer and reader contract
therefore never met in the permanent gate.

The permanent command is `agents/venv/bin/python -m pytest -q
agents/benchmarks/cloudbench_dependency_sync_test.py -k
private_fleet_source_guest_recovery_plan`. Before the production edit, its
unchanged 27 cases recorded four failures and 23 passing controls: two valid
private-source plans were rejected, and removing the registry digest (alone or
with the audit digest) incorrectly admitted legacy recovery despite retained
private manifests. The same command passed all 27 cases in 4.54 seconds after
the fix. A separate replay copied the actual owner's registry, source manifests,
audits and ten output mappings, relocating only filesystem paths into a private
fixture. The original parser returned 1; the repaired parser returned 0 with all
ten exact guest rows. Neither replay contacted providers or changed the original
owner. Commands, timestamps and exact source/test hashes are under
`.context/acceptance/proof19-recovery-source-rca/`.

The parser now permits only the documented optional source digest and verifies
both original owner copies before writing a plan. It checks the canonical audit
path and owner/run/app binding, equal SHA256-bound manifests, bounded regular
no-follow/nonblocking reads, and the existing `cloudbench-source.py` manifest
validator. Missing or partial private identity cannot silently become a legacy
owner. The recovery caller's source environment cannot substitute for the
original owner's capture. The preceding `resolve_exact_recovery_warm_identity`
continues to prove that graph roots match the source machine; the plan parser's
manifest validation alone does not establish that separate topology invariant.
Legacy owners and primary-to-worker topology remain supported; unknown/duplicate keys, malformed digests, missing/changed files,
symlinks, FIFOs, oversized/invalid schemas and wrong audit identities are rejected
without modifying durable records or publishing a plan.

Deleting the ownership allowlist would accept unknown authority, so deletion is
not a valid simplification. The repair reuses the canonical source schema rather
than adding a second schema; the added checks bind that schema to this consumer's
existing immutable owner records. Work remains bounded to two local manifests
and one owner's existing graph, with no provider call, new poller, global lock,
shared query or per-agent runtime traffic. At 10,000 agents this adds no work to
normal task execution.

The registered private-source gate passes all 70 cases in 11.84 seconds, and
four adjacent exact guest/worker mapping and quarantine recovery tests pass in
0.97 seconds. Ruff, Bash syntax and diff checks pass. Independent review reran
all 27 owning cases and 12 additional falsification controls successfully, with
no blocking findings; its receipt is
`.context/acceptance/proof19-recovery-source-review/review.json`. Full validation
and the ten-slice infrastructure proof remain separate pending gates. No task,
prompt, model, evaluator, timeout or proof threshold changed, and the case remains
open.

The parent then ran canonical exact recovery of the original owner against the
reviewed parser. All ten guests authenticated their cleanup acknowledgements
before machine teardown, and the native command exited 0 at 19:08:29 UTC on
September 13. A transient exact-machine authentication error remains in the
original recovery log; later successful reads establish the final state without
assuming that error meant absence or changing credentials.

The independent post-exit audit verified all ten exact Machines destroyed and
all ten exact Volumes unattached in provider-terminal `pending_destroy` state,
with both resource sets absent from successful inventories. The ownership
registry is absent; local and shared terminal audits agree and retain the
original source digest. All five exact archived Kernel sessions independently
returned HTTP 404. Both protected source Machines remain stopped with unchanged
native instances and full configurations, and their Volumes remain created and
correctly attached. The receipt is
`.context/acceptance/proof19-recovery-independent/verification.json`; Hub
retirement is excluded and remains a separate parent-owned action.

All ten preserved guest run JSONs were byte-matched to their hashed forensic tar
members. Their saved cleanup records show twelve tree agents sealed, every root
deleted, and the payment fixture's full 4,396-cent refund/reclaim. The unchanged
successful-query verifier counted 5–34 correlated successes in each tree using
those exact payloads. These are forensic and recovery facts only: the original
third slice still has eight `NORESULT` outcomes, Proof 19 remains failed after
two historical accepted slices, and no ten-slice streak or new acceptance credit
is awarded.

## Human feedback

The user requires completion without repeated permission requests and ten
sequential cloud slices of ten tasks with no infrastructure failures. This source
repair changes none of the requested task or validation bounds and contributes
no acceptance credit before the live proof.

The user clarified that the proof is infrastructure only: benchmark failure is
acceptable when startup, progress, evaluation and teardown function correctly.
Do not alter task prompts, model routing, schemas or evaluator thresholds to
make benchmark outcomes pass. Keep the normal 120-minute backstop and use the
explicit five-minute override for this test sequence.

## Reusable lesson

Preserve the shared-source readiness guard and carry every explicit, immutable,
independently owned alternative through pool admission, provenance and every
recovery consumer.
