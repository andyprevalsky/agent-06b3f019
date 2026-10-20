---
id: 2026-10-17-production-stripe-provenance-guard-outgrew-positive-fixtures
date: 2026-10-17
title: Production Stripe provenance guard outgrew positive payment fixtures
surface: harness
component: benchmark-payment-fixtures
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: positive payment fixtures omitted native Stripe live-mode fields required by the production lifecycle validator
symptoms:
  - "payment_lifecycle.stripeHold.livemode must be true for a production lifecycle"
  - release-stall and owned-recovery controls failed before their intended assertions
tags:
  - benchmark
  - payment
  - stripe
  - provenance
  - fixture
sources:
  - commit 00a422e282511a7796aa60fccc463d8868e73b2c
  - plan:.context/auth-deploy/benchmark-production-livemode-fixture-00a/final-result.json
  - plan:.context/auth-deploy/benchmark-production-livemode-fixture-00a/final-hashes.json
repro: agents/tests/blackbox/benchmark.blackbox.py registered production release-stall and owned-reconciliation controls
status: open
---

## Problem

The actual `00a422e` benchmark gate failed four initial controls and a fifth
later owned-cleanup control. The first reported the missing Stripe live-mode
field; others failed cleanup-await, SKIPPED-status or finalization assertions.
Those downstream symptoms did not justify weakening cleanup or the live-mode
guard. The source and both active verification/native workspaces stayed frozen.

## Diagnosis

The production-only `_validate_payment_lifecycle` correctly requires Boolean
`True` for `stripeHold.livemode`, and for `stripeRefund.paymentIntentLivemode`
when the corresponding expected section exists. Existing permanent controls
reject missing, false, null, numeric and string substitutes.

Positive synthetic producers copied catalog expectations, which describe
business outcomes without supplying native provenance metadata. Other controls
loaded an October15 retained lifecycle JSON that predates those fields. Its
organization transfer reports live mode, but that does **not** establish the
Stripe payment intent's mode. The incomplete positive inputs therefore failed
before reaching the intended release-stall/recovery boundary.

Two searches against the exact source's 935-case archive used `stripeHold
livemode fixture` and `production payment synthetic provenance fixture omitted`.
Solution and Human feedback were read in the July21 production/sandbox setup
case and October6 omitted cache-receipt fixture case. The October13 owned
payment-reconciliation case was also read. They are related lessons, not the
same first-bad boundary: live setup seeding, cache receipt equality and GET-only
recovery are distinct from this synthetic payment producer. This new case avoids
rewriting those prior diagnoses as a payment-provenance recurrence.

## Solution

Candidate `cf56cf4985a7c94c08191a33c92bdb7756ddab1e300dc2ba67d76d112ff92215`
changes only the existing benchmark test module. A clearly named synthetic
helper deep-copies its input, requires the intended transfer mode, and supplies
explicit invented LIVE-shaped Stripe fields for controlled positive tests.
It completes both owned-reconciliation terminal fixtures and release-stall
fixtures. Historical capture bytes remain unchanged; the test description no
longer claims an exact replay of unobserved Stripe provenance. Runtime guard,
tasks, timeouts, cleanup, skips and financial operations remain unchanged.

The identical local selector invoked the five actual registered owning
callbacks before and after: **5 FAIL -> 5 PASS**. The existing strict provenance
control also passed, yielding six selected passes. All **2,530** original
assertion AST nodes remain in order; one helper precondition was added. The
physical overlay imports exact `00a422e` runtime and `_test_utils` bytes.
Selected invocations made no socket attempts. Independent source review accepted
the bounded fixture change; it did not independently execute tests.

This establishes the local fixture mechanism, not a full gate. The private
full-domain attempt omitted `back-end/prisma/schema.prisma` and directly invoked
`run_all_tests` rather than the canonical runner. It also reached four
intentional funded judges. The socket guard denied their external/shared TCP
connections; no provider HTTP payload was transmitted, and DNS was not separately
instrumented. No judge result was substituted and no case was skipped. After
verifying exact private PID3521916/birth11036786, command, working directory,
boot and zero children, authorized graceful SIGINT joined with **exit130**.
Eight partial recorded failures and every setup/blocked-live attempt remain;
this is **not full-domain GREEN**. The canonical full gate on the next actual
source remains required. No private full-domain repeat, paid call or native
benchmark outcome is claimed.

## Human feedback

Root required preserving the legitimate production guard, raw capture and all
original assertions. A synthetic positive fixture may explicitly invent test
metadata; investigators must not claim that it proves historical live Stripe
provenance. Keep blocked-live/setup failures and future canonical validation
obligations visible. The user's standing direction is approval only at actual
deployment; this private candidate grants no deployment approval.

## Reusable lesson

When a strict validator gains native provenance checks, update positive fixture
**producers** to supply complete, honestly synthetic observations. Preserve
missing/wrong-type negatives and immutable historical evidence; never infer
one provider's mode from a different provider or weaken runtime validation to
rescue a downstream test. Local owning proof and a full canonical gate are
separate obligations.
