---
id: 2026-11-04-qualified-backend-exclusions-treated-as-foreign-domains
date: 2026-11-04
title: Backend native full-shard membership treated qualified exclusions as foreign domains
surface: harness
component: backend-case-adapter
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: domain_cases compared native full-shard rows only against active request checks, treating the qualified treasury row as unknown and invalidating every domain outcome
symptoms:
  - "unknown_domains: ['treasury-rails']"
  - Actual passing backend domains became UNVERIFIED after a qualified treasury exclusion
  - "AssertionError: 'PASS' != 'UNVERIFIED'"
tags:
  - backend
  - native-membership
  - qualified-exclusions
  - staged-deploy
sources:
  - commit 4f69671bb35193e19efc71eecdf7dbc8288def34
  - commit 8c63501f0afa0e3f4c5aafd3e29e01a119eb5f2a
  - PR #1662 actual43 request5917583697af47ddaa5a8cc413eb03f5
repro: python3 scripts/tests/deploy-test-worker.test.py Backend.test_qualified_treasury_exclusion_keeps_full_native_peer_outcomes
status: open
---

## Problem

Actual43 ran the unchanged full backend shards. Its request already qualified
`blackbox:treasury-rails` separately from active checks. The native producer still
included its real failed treasury row. The adapter treated that row as foreign
and changed every active domain outcome to UNVERIFIED, including passing peers.
The independent browser-session and unit failures remain actual failures.

## Diagnosis

The adapter's native membership set contained only active checks. Both the first
checked-in adapter at4f69671 and current8c reproduce `unknown_domains` containing
only treasury against the same actual43 saved summaries. This mechanism predates
the6be malformed-summary guard; that later guard did not introduce it. The
adapter is already present in current main172328, which does not release repair
ownership or qualify a waiver.

The new registered actual-shaped control invokes the existing adapter and fake
native full two-shard producer. On unchanged8c it fails `PASS != UNVERIFIED` for
the passing peer. The same assertions pass with the private correction, keeping
a browser-shaped failure, unitFAIL, thresholdUNVERIFIED and native treasuryFAIL.
All23 Backend controls pass once in9.775s; all123 preexisting test methods are
unchanged. The structural runner already registers this owning file.

A read-only parser projection of the actual saved summaries yields240 passing
active domains and the original browser-session failure. Original unitFAIL,
fpsPASS, thresholdUNVERIFIED and teardownPASS remain unchanged. This projection
writes no native result/receipt and grants no new full-gate execution credit.
Artifacts are under `/var/tmp/pr1662-43-backend-qualified-exclusion-fix`.

Archive searches used `backend unknown_domains treasury excluded UNVERIFIED`
and `qualified excluded native full shard domain membership`. The treasury
pending-custody cases concern financial-observation ownership, not this parser
membership boundary. No matching existing case was found.

## Solution

The private correction validates excluded blackbox identities against the frozen
native registry, exact request source and the existing shared qualification
policy/check. It records raw excluded outcomes and qualification hashes without
adding a case or granting PASS. Unknown members, mixed/unreadable summaries and
malformed/duplicate excluded rows still invalidate uncertain membership.
Unqualified, foreign-source, wrong-check, blocking and unregistered request
exclusions refuse before native launch. Timers, assertions, producer inventory,
coverage, cleanup, original evidence and financial obligations remain unchanged.

Parent integration, independent review and native release validation remain
separate. The original browser and unit causes remain unresolved; this case is
open until the deployed outcome is established.

## Human feedback

No new human feedback recorded. The coordinator required retaining every real
failure, original financial obligation and fail-closed membership guard.

## Reusable lesson

Validate native full-run membership against active checks plus their exact
qualified exclusions, preserving each excluded native outcome without granting
execution credit.
