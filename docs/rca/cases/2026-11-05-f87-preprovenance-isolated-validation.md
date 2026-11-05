---
id: 2026-11-05-f87-preprovenance-isolated-validation
date: 2026-11-05
title: Exact f87 pre-provenance failure blocked isolated validation
surface: harness
component: deploy-test-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: generic isolated validation required absent runtime provenance for the exact terminal preallocation campaign
symptoms:
  - preallocation evidence absent from original adapter result
  - missing execution-provenance.json before isolated validation
tags:
  - deploy
  - isolation
  - retained-owner
sources:
  - commit f87a389979fd30826a1b133cb445cc0f648d3536
repro: python3 scripts/tests/deploy-test-cycle.test.py F87IsolatedCompatibility
status: fixed
---

## Problem

The e92 campaign has ten terminal controllers, original source/patch attestation,
sealed native audits and no recorded owned resources. It predates the new early
producer protocol, so those historical sidecars cannot be created. The exact
Hub remains live and owned. Generic reconciliation cannot call its original
cleanup complete and the ce2742 pre-dispatch compatibility path does not apply.

## Diagnosis

Read-only validation of the unchanged original records fails at missing early
provenance. The same records can support strictly separate execution without
claiming historical cleanup or absence of provider mutations: native audits,
source attestation and current host observations establish the necessary
isolation boundary. The original receipt, adapter result, source/patch seal,
summary, ten lifecycle records, Hub identity and relay location are pinned by
SHA-256 for this one exact source and request.

## Solution

An explicit compatibility proof is accepted only for isolated-validation, the
exact original f87 token/receipt and pinned native bytes. Existing participant,
resource audit, publication, source, inventory and new-source checks continue.
Fresh read-only OS checks allow only the exact retained Hub incarnation; another
live or unreadable process refuses admission. Both runtime provenance files
must remain absent, preventing retroactive producer evidence.

The result preserves all failed receipts and attempts, retains the original
namespace and Hub, sets cleanup_complete=false and credit_granted=false, and
uses the existing fresh-token/fresh-directory launch contract. No ordinary
cleanup path or unrelated source gains this compatibility. This is not a
no-provider-mutation assertion or a gate waiver.

## Validation

The actual original evidence fails under the old validator and passes the new
isolated validator. An in-memory copy of the actual cycle admits execution while
its failures/attempts remain equal and the canonical cycle bytes are unchanged.
Registered synthetic controls refuse wrong authority, changed originals,
unknown live processes, unreadable OS state, changed Hub incarnation, stale
observations, resource records and added retrospective provenance.

## Human feedback

User requires a read-only audit, no historical sidecars, no resource or financial
mutations, and preservation of all original cleanup obligations. Parent alone
may integrate and import a proof at the current frozen-source boundary.

## Reusable lesson

A strictly pinned execution-only compatibility path may retain historical debt
while admitting a separately identified run. It must never convert missing
historical provenance into an invented cleanup or success claim.
