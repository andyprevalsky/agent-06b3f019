---
id: 2026-10-28-it10-forensic-runtime-fact-hardcoded-true
date: 2026-10-28
title: Forensic observation rejected an authentic runtime capture present fact
surface: infra
component: cloudbench-forensic-resource-closure
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Forensic prepare required runtime_evidence_missing true instead of the authenticated original strict boolean
symptoms:
  - forensic failure facts differ
  - Guest cleanup missing is true while runtime evidence missing is false
  - GET-only original-scope observation refused before execution
tags:
  - it10
  - i34
  - forensic-observation
  - strict-boolean
sources:
  - commit 82f06409be766f75bbc1b93c194457dfce80625e
  - commit 5bd4576026ceda7c9469543f945c18bcf91c1ac6
  - fleet run 20261028-181750-1195
repro: python3 scripts/tests/cloudbench-forensic-resource-closure.test.py
status: fixed
---

## Problem

After It10 aborted before workload admission, canonical forensic PLANONLY
refused the original cleanup record with `forensic failure facts differ`.
No observation execution or consumer ran at that refusal. The exact184-byte
cleanup SHA256 is
4a959091f2949a4594fe91523e4ada5a4ee787b92cd27e0753d8ad9d1a88a6be.
It records guest_cleanup_missing=true, runtime_evidence_missing=false and
successful_runtime_inferred=false for the owner above. These are separate
facts; captured runtime evidence does not establish guest cleanup or sealing.

## Diagnosis

The original run-bench-fleet::fleet_record_disposable_cleanup_state producer
serializes guest and runtime missing flags independently. Forensic prepare
already authenticates the raw cleanup against its original archive manifest,
then compared its entire object to a dictionary hardcoding runtime missing true.
That equality rejected a legitimate producer state before any current native
observation. Original missing cleanup is not repaired by interpreting the
runtime capture as successful cleanup.

Two archive searches covered the literal refusal/runtime flag and forensic
retained guest cleanup. The I31 follow-up in
2026-10-19-native-release-audit-ignored-retained-fleet-ownership and the full
2026-10-07-mixed-cohort-forensics-required-retired-primaries-active case were
read, including Solution and Human feedback. Both require preserving authentic
historical state while validating a separate current observation. The local
producer and exact plan verifier are the authority for this boolean contract;
no unrelated external implementation supplies Fly ownership semantics.

## Solution

Accept only an actual bool for the authenticated runtime missing field, still
requiring exact schema/owner/guest flag/success=false and no unexpected fields.
Newly admitted false is explicit as historical_runtime_evidence_missing=false
in the hash-bound plan. Existing true plans keep their prior shape; their raw
cleanup remains bound by the original input hash. Verification recomputes the
exact plan, rejecting changed facts even if an outer receipt is rehashed.

The observer remains GET-only. Full original export, source, app, protected
resources, complete fresh scope, original exclusive delete intents, native
creation/fence/ACK identities, current positive app authority, exact terminal
GETs, deadline and publication custody remain required. Runtime_sealed=false,
claims_released=false and original_release_epoch=null remain unchanged. This
repair does not grant stop/delete/reaper authority.

Independent reviewer ph7eq6ca0cp3vnxvh8qh26c4ts8h5bmt returned scoped GROUNDED for
exact two-file patch SHA256
f40e07740d39f59b980c98371299fcd4089ed5fba5687871c523a11723f9898f.
Source commit5bd4576026ceda7c9469543f945c18bcf91c1ac6 applies those exact bytes.
The isolated branch first synced main100560926 into846862883; its48 focused
frontend controls passed, with no DB work by this investigator.

### Same offline boundary and permanent regression

Four new controls run actual prepare/observe/verify/reconcile and canonical CLI
against the existing loopback native adapter. The fixture verifies the exact
original184-byte cleanup hash and rebinds only owner into an existing synthetic
full archive. It is a producer-state reproduction, not an authentic full private
archive replay. Baseline: two errors and six subtest failures; false is rejected
by prepare/CLI. Candidate: all23 registered controls pass in5.298s; after exact
application all23 pass in5.193s. The reviewer independently reproduced RED/GREEN.

The controls cover strict false, old true plan compatibility, numeric0/1,
strings, missing/null facts, forged owner/guest/success/extra fields, rehashed
plan mismatch, GET-only full consumer, and unchanged original audit. Existing
19 controls preserve identity/fullscope/deadline/atomic-publication refusals.
No provider/model/browser/DB call was made by these tests.

### Actual full original-scope closure

Unlike the synthetic regression, the later owner operation consumed the real
three verified exports and private authority on source5bd457602. Inventory,
plan, execute and full consumer all exited0. The canonical projection SHA256 is
72cb499911cd7d4a160a6ea76d1d99fafc2ae1e7d34a8ee3c618cd9a064c5f6e;
selected recovery receipt SHA256 is
c481437495efc8f858c1b463dedc0b9c18966df7a2998d090de7a12eb3a530df.
The current observation SHA256 is
cbc092ecc1b63b865bd7aeb5c3f14ee01f2c9f7160a856d6dab5bf022f2cc293.

At epoch1793214705.1999094 the full consumer reports current physical resource
release verified and all resources terminal, but all_resources_absent=false.
All10Machines are destroyed and all10Volumes pending_destroy; all20 remain
provider-terminal-retained records with exact GET HTTP200. An earlier local
list enumerated only6Volumes and is superseded for scope by this canonical
10Volume proof; that list was never canonical closure.

The final custodian receipt binds the projection and records unchanged before/
after hashes, inode, size and mtime for original result, native audit and all
three archive/manifest pairs. The original audit SHA256 remains
742827225326a826c9e4c7a3c99b8ea8c47c4a3c9349f341db30626aaa25ec08.
Historical released=false, runtime unsealed, claims unreleased, epoch null,
old infra retained and benchmark_success_inferred=false remain. All70 original
slots remain cancelled/UNKNOWN; no task PASS/FAIL or acceptance credit is added.
The actual infra-probe failed at1/2 readiness before admission. That proves
neither a global absence of external browser sessions nor a new task outcome.

## Human feedback

Preserve all original refusals, ownership and failure facts. Distinguish a
strict independent runtime fact from guest ACK or successful runtime claims.
Use the actual original shape for the causal fixture and disclose synthetic
owner rebinding. Missing historical FE/model artifacts do not block a strongly
grounded infrastructure repair; do not invent artifacts or request a waiver.
Only the owner performs canonical native reads. No extra retries, source hot
patches, provider writes, DB work or new benchmark were authorized here.

## Reusable lesson

Authenticate and preserve independently recorded facts instead of hardcoding
one failure combination. A current terminal-resource observation can close
physical custody while leaving every historical runtime and task failure intact.
