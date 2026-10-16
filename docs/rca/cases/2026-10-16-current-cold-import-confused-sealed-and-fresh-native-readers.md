---
id: 2026-10-16-current-cold-import-confused-sealed-and-fresh-native-readers
date: 2026-10-16
title: Current-cold import read destination observations through the sealed source resolver
surface: infra
component: cloudbench-startup-failure-archive
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: verify_current_cold_receipt passed fresh destination native paths to sealed_original_reader
symptoms:
  - "KeyError: child-before.json"
  - "verify_current_cold_receipt -> current_cold_native -> sealed_original_reader"
  - "import driver_exit_code 1 with init_resumed true"
tags:
  - cloudbench
  - cold-handoff
  - sealed-originals
  - native-proof
sources:
  - PR #1525
  - commit 6189d6e6cdbcc82d7715809daef25158e6834534
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py CurrentColdImportedNativeTests RetainedTargetSourceSuccessorTests
status: fixed
---

## Problem

The actual import attempt `ebf7f9fc22116cdaf6933666a940add1` exited1 before
claim publication. Its traceback ends at `sealed_original_reader` looking up
`/tmp/gate/repo/.context/pr1525-continuation/v41-retained-ops/import-ebf7f9fc22116cdaf6933666a940add1/child-before.json`.
The supervisor reported `init_resumed:true` and no unexplained writers. The
source packet was already SOURCE_COMMITTED and must not be edited or exported
again merely to add destination-local filenames.

Original evidence is retained under
`.context/pr1525-continuation/final6189-import-native/once-ebf7f9fc22116cdaf6933666a940add1/latest-status.private.json`.
The unchanged source packet is206655 bytes, SHA256
`982d377ade3a4e96f414cde1d4d658e30dd8dc72ae07b75dbababe9bcd0527ea`.

## Diagnosis

Path: retained endpoint import -> import_cold_handoff ->
verify_imported_cold_handoff -> verify_handoff_phase ->
verify_current_cold_receipt -> current_cold_native -> sealed_original_reader.
The source receipt/archive and original before/after files are sealed under
source paths. Fresh destination observations are separate inputs. The current
receipt verifier selected the sealed resolver for *both*, whereas the sibling
preconfig verifier already separates historical and current observations.
Existing round-trip tests reused source paths for destination observations and
therefore missed this boundary.

The registered reproduction now captures, commits and exports real sanitized
current-cold fixtures, then imports with distinct destination paths. The
unchanged tests fail on6189 with the same destination `child-before.json`
KeyError. A second fixture uses the exact6189 producer source, preserved as a
small gzip fixture, to reproduce the already-issued capsule compatibility
requirement. Tests also require missing source entries to stay fatal even when
matching files exist locally, bind original native bytes to receipt digests,
reject fresh instance/config drift before claims, and reject an unapproved
capture helper even in a self-consistent repacked archive.

A separate read-only replay of the actual packet produced the same KeyError
before the fix and passes afterward with new temporary before/after paths.
It calls verify_imported_cold_handoff only, makes no provider/guest calls and
never edits the packet or publishes destination claims.

Archive searches used `sealed_original_reader KeyError` and
`current cold import native destination proof`. The retained-controller endpoint
case is a related caller, not a recurrence of its init-shape admission cause.
The sibling verify_preconfig_receipt implementation is the direct repository
reference: sealed source evidence first, fresh native observations separately.
No external reference acquisition or deployment was needed for this bounded
local verifier defect.

## Solution

Verify receipt-recorded native paths through the sealed resolver first, comparing
all returned source path/digest/identity fields to the receipt. Independently
verify the supplied fresh pair through the ordinary strict native-file reader,
then compare its instance/config identity to the committed allocation. The
archived volume remains sealed evidence for both checks. The sealed resolver
still has no local fallback, and missing source paths are never filled from
fresh observations.

The verifier accepts the exact approved6189 capture-helper digest in addition
to its current producer digest. It does not execute archived code or accept
caller-selected hashes. That same exact producer is admitted to the existing
guest-source allowlist, where the unchanged guest AST/semantic comparison still
applies. Unknown or modified helper bytes remain rejected. Original source
meta, latches, outer terminal, archive and task/dependency predicates remain.

Command: `python3 scripts/tests/cloudbench-bootstrap-recovery.test.py CurrentColdImportedNativeTests RetainedTargetSourceSuccessorTests`.
All13 cases passed five consecutive runs with unchanged test and implementation
bytes, after the same final tests failed on the6189 implementation. The fresh
native pair also explicitly rejects two hard-linked paths to the same file;
substituting the sealed-volume reader must not remove that identity guard. The suite
is already registered as `cloudbench-bootstrap-recovery` in
`scripts/run-deploy-structural-gates.py`; default unittest discovery includes
the new class. Three existing current-cold/absent-runtime/preconfig import cases
also pass. Native integration and final600 qualification remain root-owned;
this fix claims neither native success nor benchmark qualification.

## Human feedback

The user required an isolated fix while the main6189 checkout was active, no
provider/guest calls or packet/stage edits, five unchanged regression passes,
and preservation of the already-sealed old capsule. The user explicitly ruled
out adding destination paths to the old seal, bypassing source guards or giving
the sealed resolver a local fallback. Root retains integration and native work.

## Reusable lesson

Verify immutable source evidence through its sealed resolver and fresh destination observations through their explicit current reader, then compare identities without merging the two namespaces.

### Explicit target-source successor and completed import

The actual immutable packet targets6189. The repaired helper necessarily has a
new source ref. The retained endpoint now supports an explicit separate
`target_source_successor` request containing exact `old_ref`, `new_ref` and a
private `receipt_output`. It validates the actual new endpoint under the existing
canonical live retained-controller verifier, unchanged Machine/Volume/config/
roots/ownership/preservation/pool fields, and ancestry from the exact old ref.
Every packet/native/volume/ownership/continuation input is hash-bound. It never
rewrites the old packet or changes generic target equality. Base import uses
the original target only after this separate live admission succeeds.

Only after the canonical import audit and terminal exist does import durably
publish a completion attestation in the same private common store. It binds
original packet SHA, both targets, continuation and physical root anchors,
and exact-owner nofollow file inode/content bindings for the successor receipt,
audit and terminal. A prepared proof or incomplete import cannot authorize
pool reuse. Exact recovery after a terminal-publication interruption is allowed
under live admission; conflicting bytes remain fatal.

Later pool checks consume that same immutable proof plus completion, check
actual current source/common and clean scripts, physical roots and ownership,
and retain full fresh child native/volume and sealed-source verification. They
do not require the completed import driver to remain alive. A subsequent
source ref requires separate supported admission; it is not globally accepted.
Registered cases cover post-driver-exit reuse, preterminal refusal, exact
postterminal recovery, missing or modified completion, changed audit, replaced
terminal inode, hard-linked proof, wrong source/common, and initial wrong
packet hash/target/config/continuation/physical root.

The retained-process boundary is mocked in these offline successor fixtures;
existing canonical endpoint and continuation tests cover that implementation.
The actual old packet is separately replayed through its exact sealed producer
and fresh child observations, with a clearly labelled offline successor-boundary
replay. Root must prepare real fresh canonical continuation/native inputs on
the new checkout and independently review this change before native execution.
No provider/guest calls, runtime integration or REAL600 qualification are claimed.
