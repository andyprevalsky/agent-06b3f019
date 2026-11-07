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
tags:
  - deploy
  - cleanup
  - evidence
  - bounded-parsing
sources:
  - PR #1708
  - commit b93150574e7b7d7e0d7a11170db65c9c8305a0a3
  - commit 4a0623371f8814da22b48e16522dcd2181e782d0
repro: python3 scripts/tests/deploy-test-plan.test.py NativeRunArtifact
status: fixed
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

## Human feedback

The user directed autonomous resolution after the internal file-size limit was
explained. Cloud/test capacity, width, timeouts, tasks and assertions remain
unchanged. The file-reading allowance is unrelated to a spending budget.

## Reusable lesson

Separate control receipts from intact forensic payloads. Bound both explicitly,
verify all original bytes, and preserve historical failure projections even when
later evidence permits a new launch.
