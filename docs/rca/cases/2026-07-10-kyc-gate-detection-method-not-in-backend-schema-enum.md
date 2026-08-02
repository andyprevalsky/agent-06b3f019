---
id: 2026-07-10-kyc-gate-detection-method-not-in-backend-schema-enum
date: 2026-07-10
title: The KYC gate sent a detection.method the backend schema enum rejected, so gate creation 400'd and no resolver existed anyway
surface: cross
component: gate-service
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: build_kyc_gate — emits detection.method "agentcard_error", which is absent from the backend gateSchema enum
symptoms:
  - KYC gate creation returns 400 from the backend
  - '"agentcard_error" rejected by gateSchema'
  - no kyc resolver call site exists, so a created KYC gate could never be resolved
tags:
  - gate
  - kyc
  - schema-validation
  - agentcard
  - stripe
sources:
  - memory:project_gate_benchmarks_fe_verification
repro: none-recorded
status: open
---

## Problem

The KYC gate was doubly broken. `build_kyc_gate` emits
`detection.method = "agentcard_error"`, a value that is not in the backend
`gateSchema` enum (it should be `kyc_webhook`), so gate **creation** 400s. And even
if creation succeeded, no `kyc` resolver call site exists — a created KYC gate
could never be resolved.

## Diagnosis

Two independent halves of one contract were never exercised end-to-end: the Python
producer and the TypeScript schema disagreed on an enum value, and the resolver
side of the gate lifecycle was simply unimplemented for this gate type. Both are
invisible to a unit test on either side; only a real KYC trigger would surface
them. Two adjacent defects in the same path were noted: `isKycRequiredError`
treats an undefined status as pass-through, and a KYC retry may reuse a Stripe
idempotency key against an already-canceled hold.

## Solution

Not fixed — the user triaged KYC resolver wiring to a follow-up PR. The generalizable
requirement recorded: a gate type is only shippable when its producer's enum values
are validated against the backend schema **and** a resolver call site exists, i.e.
every gate needs a proven create→render→resolve round trip before it counts as
wired.

## Human feedback

The user triaged this cluster and explicitly approved deferring the KYC resolver
wiring (along with fixture-script dedup, source→connector map unification, and
checkout-mint idempotency hardening) to a follow-up rather than expanding the
shipping PR.

## Reusable lesson

A gate or request type is not wired until its create path passes the backend schema
enum and a resolver call site exists — validate cross-language enums and prove the
full round trip, never just the raise site.
