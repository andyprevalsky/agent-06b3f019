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
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py CurrentColdImportedNativeTests
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

Command: `python3 scripts/tests/cloudbench-bootstrap-recovery.test.py CurrentColdImportedNativeTests`.
All6 cases passed five consecutive runs with unchanged test and implementation
bytes, after the same final tests failed on the6189 implementation. The suite
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

### Native rollout prerequisite

The source-reader fix does not authorize changing the packet's destination
source ref. The actual packet targets6189. Retained endpoint capture still
requires actual HEAD == request.tool_ref, import requires exact target equality,
and later imported-pool verification requires that original target source ref.
Root must coordinate a separate explicit, canonical-continuation-bound target
source-successor proof before importing this old packet on a new source. Such
a proof must retain original packet/target bytes, verify all physical endpoint
fields and old/current custody, and be checked again by later pool-proof reuse.
No generic equality check is relaxed by this patch; a new source alone is not
native execution authority.
