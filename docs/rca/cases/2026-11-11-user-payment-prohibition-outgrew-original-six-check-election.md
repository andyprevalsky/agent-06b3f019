---
id: 2026-11-11-user-payment-prohibition-outgrew-original-six-check-election
date: 2026-11-11
title: Newly selected payment tasks lay outside a deliberately finite user election
surface: harness
component: deploy-test-cycle
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: elect-user-omission refused a later user prohibition for paid catalog cases outside the original six-question election
symptoms:
  - "user omission election: typed election request required"
  - "browser-auth-guest-purchase"
  - "browser-auth-member-discount-purchase"
tags:
  - user-election
  - payment-custody
  - preexecution-admission
sources:
  - plan: PR1915 frozen f268 smoke inventory and original native user restriction
repro: Run scripts/tests/deploy-test-user-omission.test.py with the added paid-prohibition cases against the old module
status: mitigated
---

## Problem

The original approval concerned exactly six AgentCard checks. The later native
user instruction prohibited all new paid AgentCard creation or reclaim. The
current smoke selection has fifteen tasks, including two further purchase
cases that require positive card, Stripe hold and organization-transfer
fixtures. Expanding the original six-question schema would invent approval;
leaving the cases admitted would violate the later instruction. The gap was
caught before smoke admission. No failure, permission or financial action was
manufactured.

## Diagnosis

The refusal occurs at the exact request-kind and six-question schema check,
before any native execution. The new cases are selected by the actual native
payment predicate and carry positive financial fixture contracts. Existing
mock or read-only cases do not satisfy that predicate.

## Solution

The normal election API now accepts a distinct typed prohibition record bound
to the actual native USER evidence, current source/environment/plan/inputs,
and hashes of the native payment predicate and task catalog. It covers only
the complete selected paid intersection outside the original six, requiring
the actual payment fixture, runner, tags and positive financial lifecycle.
Original election records and financial custody remain intact. Both records
are revalidated by the existing execution and preallocation consumers; stale
bindings fail closed until explicit renewal. Outcomes are UNEXECUTED/SKIP,
with zero execution, assertion and financial credit. Mock/read-only tests
are not omitted. A present null ledger is rejected before projection or
mutation, while an absent ledger remains valid.

## Validation

The three added owning methods failed against the original module and the
same thirty-test suite passed after the extension. Independent review found
a null-ledger refusal gap; the added same regression produced four failures
and four errors before the correction, then the full thirty-one tests passed.
The actual frozen f268 plan and existing five elections independently project
exactly the two additional paid omissions through the native consumer. This
is offline implementation proof, not an applied election, paid-task PASS or
production acceptance. Native admission and the full SDK deployment remain
root-owned.

## Human feedback

The original native USER reply was “SKIP agentcard bs” for the exact six-check
question. The continuing native USER message said: “No paidAgentCard
new/reclaim; user SKIPagentcardbs exactsixscope remains, $43.96UNKNOWN
financialdebt remains.” The original transcript body export gap is retained;
its scoped search and exact cursor reference are joined to the continuing
native USER message. Agent attestations grant no authority.

## Evidence

PR1915 private financial-election/broad-prohibition contains the hash-bound
native authority, actual plan/cycle snapshot, tests-first receipts and both
independent review rounds. Prior $43.96 settlement remains UNKNOWN and
NO_RETRY custody remains zero credit. No new card, hold, fund or reclaim was
performed for this repair.

## Reusable lesson

A finite approval and a later broad prohibition are distinct authority records.
Bind both to current selected operations and refuse stale records at the actual
execution boundary; never fabricate a failed test merely to register an omission.
