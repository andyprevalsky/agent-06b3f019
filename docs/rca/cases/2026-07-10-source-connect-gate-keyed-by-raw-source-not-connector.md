---
id: 2026-07-10-source-connect-gate-keyed-by-raw-source-not-connector
date: 2026-07-10
title: The source_connect gate was keyed by raw source, so an `email` gate never matched the `gmail` callback and parked forever
surface: back-end
component: gate-resolver
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: source_connect gate key — stored the raw source (`email`) while the OAuth callback resolves by connector (`gmail`)
symptoms:
  - agent stays parked on a Connect-Gmail gate after the user connects Gmail
  - gate is never resolved and the workflow never resumes
tags:
  - gate
  - oauth
  - gmail
  - connector
  - identifier-mismatch
sources:
  - memory:project_gate_benchmarks_fe_verification
  - commit dc012006
  - commit 302164ed
repro: none-recorded
status: fixed
---

## Problem

A `source_connect` gate raised for email stayed pending even after the user
completed the Gmail connection: the gate was never resolved and the agent parked
forever.

## Diagnosis

The gate was keyed by the **raw source** string as the agent saw it (`email`),
while the OAuth callback that resolves the gate identifies itself by **connector**
(`gmail`). The two identifiers never compared equal, so the resolver found no
matching gate. Found during an extra-high-effort code review of the gate work
rather than by a failing test — nothing in the system asserted that the key a gate
is created with is the key a resolver will look it up by.

The same review found a cluster of adjacent fragility in the gate resolution path:
fan-in waiter races (fixed with a `repo.appendGateWaiter` `FOR UPDATE`, resolvers
re-reading waiters after `updateResponse`, and a signal for late joiners) and a
missing subscription-Checkout mint idempotency key that produced duplicate
sessions on retry.

## Solution

Key `source_connect` gates by **connector**, not raw source, so creation and
resolution agree (commits `dc012006`, `302164ed`). The same commits landed the
fan-in waiter locking/re-read/late-joiner signal and the Checkout mint idempotency
key. Recorded as still-deferred debt: the source→connector map exists in three
places and should be unified — duplicated mappings are how this mismatch became
possible.

## Human feedback

The user triaged the review findings, approving deferral of the KYC resolver
wiring, fixture-script dedup, source→connector map unification, and checkout-mint
idempotency hardening to a follow-up rather than expanding the shipping PR.

## Reusable lesson

When a request parks forever waiting on a callback, check that the identifier used
to create the wait is the exact identifier the callback resolves by — normalize to
one canonical key rather than mapping between namespaces in three places.
