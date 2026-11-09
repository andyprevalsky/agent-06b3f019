---
id: 2026-11-07-native-cleanup-confused-forensic-run-with-receipt-size
date: 2026-11-07
title: Native cleanup treated a complete forensic run as a small transport receipt
surface: harness
component: staged-deploy-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: native cleanup applied its ordinary 64 MiB receipt reader to a 99,297,775-byte original run record containing forensic logs
symptoms:
  - "native cleanup: proof file too large"
  - "native artifact: raw file byte bound exceeded"
  - "native artifact: materialization bound exceeded"
tags:
  - deploy
  - cleanup
  - evidence
  - bounded-parsing
sources:
  - PR #1708
  - commit b93150574e7b7d7e0d7a11170db65c9c8305a0a3
  - commit 4a0623371f8814da22b48e16522dcd2181e782d0
  - commit 77744c54e7da30fd57c8b1c3295b9f9c70249fd5
repro: python3 scripts/tests/deploy-test-plan.test.py NativeRunArtifact
status: open
---

## Problem

A failed nine-task deployment cohort retained a complete original run JSON of
99,297,775 bytes. Its ten participant run files totaled 133,853,038 bytes. The
cleanup verifier required those exact bytes but also rejected every proof member
above the ordinary 67,108,864-byte receipt limit. Consequently neither preserving
the original record nor supplying complete native retirement evidence could
make the next launch admissible.

## Diagnosis

The same unmodified 495-file proof failed on the canonical bounded reader at
`b9315057` with `raw file byte bound exceeded`. This was an evidence-consumer
contract mismatch, not an application failure or proof of a provider outage.
The run combined small control metadata with large forensic log subtrees;
materializing the entire document as a small receipt was the wrong interface.
Trimming logs, rewriting original results, or excluding the file would conceal
the original evidence and was rejected.

## Solution

Read native participant run records through a regular, canonical, non-symlink
descriptor in 64 KiB chunks. Verify the complete original hash, JSON grammar,
UTF-8, decoded duplicate keys, and pre/post descriptor and path identity. Only
the explicitly recognized forensic log subtrees receive opaque references;
control and unknown metadata remain bounded and materialized. Cancellation and
an existing caller deadline remain authoritative. Recovered runtime/payment
documents retain their existing full validation.

Keep the generic raw, ordinary receipt, metadata and scalar limits at 64 MiB.
The explicitly directed forensic path admits at most 128 MiB of participant run
bytes in aggregate, charged from each verified descriptor before reading. This
is an I/O/materialization accounting contract, not a hard 64 MiB process-RSS
promise. Isolation revalidation retains the same exact file set and hashes.

The full planner suite passed 68 tests, including shared-budget exhaustion and
malformed-budget controls. Existing guards cover wrong hashes, malformed opaque
JSON, duplicate keys, large control metadata, FIFO/symlink input, cancellation,
deadline expiry, and concurrent truncation. The cycle and CLI/review suites
also passed. On the canonical repaired verifier the original proof validated
all 495 bindings, ten participant fleets and ten retirement audits; normal
reconciliation then succeeded without changing any original attempt or failure.
The proof SHA256 remains
`895cb94dc2f18052486f12a6446ac70b865f6d2b2bddbdf53f0054e6f0ae9b01`.

Evidence is retained under
`.context/rca-browser-4f77/relentless-strict64-integration/` and
`.context/rca-browser-4f77/authorized-internal-unblock-1812/`. Acceptance is
launch eligibility only: all 312 historical failures, the original nine
UNVERIFIED outcomes, retained Hub custody and financial liabilities remain.
It does not prove current-source smoke, production deployment, fresh provider
state, or settlement of any historical obligation.


## November 7 recurrence: transient opaque-key accounting

Review finding 4503659936 was reproduced on frozen 77744c54e7da30fd57c8b1c3295b9f9c70249fd5. The reader method ASTs are identical to b9315057 and 4a062337: this is a limitation of the prior bounded-parser repair, not evidence that a later source sync introduced it. The older main b365 and original 0d3 have no deploy_test_run_artifact.py; do not infer a NOT_INTRODUCED result against those baselines from the narrower comparison.

Inside tasks[*].logs and tasks[*].owned_roots[*].logs, objects are parsed with keep=False but their decoded duplicate-check keys and set growth were charged forever. Sibling objects are already dead when the next one parses. The counter therefore measured cumulative allocations rather than simultaneously live metadata. A valid 24,040-byte document with 3,000 tiny log objects fails through the normal read_run_artifact entrypoint at its unchanged 4,096-byte metadata limit. With the ordinary 67,108,864-byte limit, a 5,000,041-byte document also fails: the old charged total reaches 67,108,979 on the owning Python 3.11.9 despite low live parser state.

The minimal correction snapshots materialized when a non-retained container opens and restores that value only after the complete container closes. Nested scopes preserve the charges for every still-open ancestor key set. Retained scalars, objects, values and opaque references retain their existing accounting. No byte limit, scalar/depth rule, parser grammar, hash, FD identity, cancellation or deadline check changes.

The identical owning reproduction exits 1 before and 0 after. All 18 NativeRunArtifact tests pass, including all 13 original tests and five additions: sibling objects on both opaque paths, giant single/live nested key sets, decoded duplicate or malformed opaque tail after many siblings, and retained scalar accumulation. The owning deploy-test-plan gate registration is unchanged. This focused owning class is not a claim that the full planner or entire deployment gate passed.

At the ordinary 64 MiB limit, the same 5 MB reproduction passes after the fix with a peak charged state of 1,433 bytes on the owning Python 3.11.9 (the host Python 3.12 check measured 1,337). That is instrumentation of the existing accounting counter, not a process-RSS measurement or new budget. Read-only compatibility replay verifies all 495 original file hashes and parses all ten native run files, totaling 133,853,038 bytes, through the unchanged 128 MiB aggregate allowance; the largest original file remains 99,297,775 bytes and the remaining allowance is 364,690 bytes. The unchanged public native validator also accepts the existing 495-binding normal proof, returning ten participants, ten audit seals, one retained service and credit_granted=false. No canonical reconciliation, failure projection, resource, financial debt or test credit is changed.

The candidate and permanent tests are private under .context/rca-browser-4f77/review-findings-2109/artifact-child. Source and test patch hashes, exact commands and before/after logs are supplied there. This case is reopened only for the bounded-reader recurrence pending required source-bound gates and deployment. The prior raw-evidence repair and all its original evidence remain recorded above. The fix is O(1) additional accounting per container, adds no provider/network/DB work, and does not change deployment concurrency. Golden reference: not applicable to this ordinary parser/owning-test correction.

## Human feedback

The user directed autonomous resolution after the internal file-size limit was
explained. Cloud/test capacity, width, timeouts, tasks and assertions remain
unchanged. The file-reading allowance is unrelated to a spending budget.

## Reusable lesson

Separate control receipts from intact forensic payloads. Bound both explicitly,
verify all original bytes, and preserve historical failure projections even when
later evidence permits a new launch.

## November 9 recurrence: proof aggregate versus per-run admission

PR1896 retained all thirteen original parent runs and its linked canary. Their
verified original run files total 212,366,375 bytes. Each fits the existing
128 MiB per-run forensic bound, but the shared 128 MiB proof counter rejects
the complete cohort before native custody validation. Omitting participants or
rewriting logs would conceal required evidence.

The correction gives native cleanup a separate finite 512 MiB proof-wide raw
I/O allowance. The per-run 128 MiB cap, ordinary 64 MiB materialization/scalar
bounds, 64 KiB streaming, complete JSON/hash/descriptor verification and every
variant/source-pin/custody predicate remain unchanged. Standalone readers still
default to the original aggregate allowance. This is not a task, timeout,
coverage or concurrency change.

The same registered real two-by-65-MiB log-array test fails on the original
aggregate guard and passes after separation; individual scalars remain 1 MiB.
Aggregate exhaustion, per-run exhaustion, malformed/trailing input, hash drift,
standalone defaults and scalar bounds remain negative controls. Independent
review cleared exact diff 074e6eda07b8450a111915275d1ef2c17ec58c0d3bfcc69395493c221406b5ee.
Evidence is retained privately under .context/deploy-pr1896-continuation/smoke-rca/aggregate-candidate.

A pure replay validated all fourteen participants with credit_granted=false,
cleanup_complete=false and obligations_preserved=true. It neither reconciled
the live cycle nor cleared financial, browser, guest/runtime, provider or Hub
custody. Required frozen-source gates and production acceptance remain pending.
