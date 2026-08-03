---
id: 2026-07-21-prod-only-task-inherited-sandbox-setup-fixture
date: 2026-07-21
title: The production AgentCard lifecycle task inherited the sandbox setup fixture, pairing a live credential with a sandbox cardholder
surface: harness
component: benchmark-fixtures
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the production lifecycle task definition — it inherited `expected_payment_lifecycle`, so the runner seeded the sandbox setup fixture before creating the agent
symptoms:
  - "Cardholder not found" from the live AgentCard readiness check
  - production AgentCard lifecycle benchmark fails at preflight
  - "transfer completed with livemode=false" on a production gate
tags:
  - agentcard
  - benchmark-fixtures
  - stripe
  - livemode
  - sandbox-vs-prod
sources:
  - PR #838
repro: registered benchmark blackbox regression for the production fixture policy
status: fixed
---

## Problem

The production-only AgentCard lifecycle benchmark failed its live readiness check
with `Cardholder not found`. Worse, in the cases where that preflight _did_
succeed, it succeeded under sandbox credentials and the resulting transfer came
back `livemode=false` — meaning the production gate was passing without ever
exercising production.

## Diagnosis

The production lifecycle task inherited `expected_payment_lifecycle`, so the
runner ran the benchmark **setup fixture** before creating the agent. Render then
paired a live AgentCard organization credential with the old sandbox cardholder
ID, and the live readiness check correctly reported `Cardholder not found`. The
readiness check was right; the fixture was wrong. The deepest owned cause is that
synthetic setup seeding was inherited by default, so a task whose entire purpose is
to exercise the normally persisted live integration was silently handed a
substitute sandbox environment — a fixture/environment mismatch that could either
fail loudly (cardholder mismatch) or, more dangerously, pass falsely
(`livemode=false`).

## Solution

Production-only lifecycle tasks now skip synthetic setup seeding entirely and
exercise the normally persisted live integration; local lifecycle and one-time
setup/resume behavior is unchanged. A registered blackbox regression pins the
production fixture policy — the focused pre-fix regression reproduced the failure
and the full benchmark domain passed post-fix.

## Human feedback

The project owner explicitly waived the repository's Claude fallback review for
this PR because that account could not add more credits. The production benchmark
was deliberately **not** rerun: the user-bound live AgentCard cardholder was still
KYC `pending`, so the Render cardholder binding was corrected and the verification
session resumed instead — rerunning before KYC verification would be unsafe and
could not pass.

## Reusable lesson

A production-only benchmark must never inherit synthetic setup seeding — mixed
live credentials with sandbox fixture IDs either fail at preflight or pass with
`livemode=false`, which is worse.
