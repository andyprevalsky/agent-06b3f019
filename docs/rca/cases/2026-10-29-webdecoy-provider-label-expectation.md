---
id: 2026-10-29-webdecoy-provider-label-expectation
date: 2026-10-29
title: WebDecoy isolation gate depended on a provider-specific profile label
surface: agents
component: benchmark-isolation-expectations
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Provider-neutral WebDecoy task required Kernel profile_source metadata
symptoms:
  - Expected isolated browser session metadata was not observed
  - Valid fresh Tilion metadata rejected
tags:
  - benchmark
  - isolation
  - provider-neutral
sources:
  - PR #1634
repro: .context/pr1634-webdecoy-isolation-rca/provider-neutral-before.log
status: fixed
---

## Problem

The WebDecoy smoke required profile_source=new_user_persistent even though its
prompt and fresh-session setup are provider-neutral. The captured Tilion session
reported tilion_ephemeral and satisfied every required auth/storage check. The
original smoke failure and its full terminal evidence are preserved.

## Diagnosis

The unchanged evaluator compares all expected metadata fields on one metadata
item. Its provider-specific label rejected the captured session before evaluating
the actual outcome. The prior proposed Tilion-specific replacement was never
applied. The user instead explicitly instructed: "it shouldnt expect any label
there". This supersedes that proposal, rather than authorizing a different label.

## Solution

Remove only the profile_source expectation from WebDecoy. Add no provider pin.
Retain auth_source=none, cookies_injected=false, zero cookies, local-storage
origins, IndexedDB origins, permission grants and cache-storage origins. Fresh
setup, task prompt, evaluator and 0.163 risk threshold remain unchanged.

The registered provider-neutral regression failed with the original catalog and
passes with the correction. It accepts different or absent provider/source labels,
rejects each missing or contaminated auth/storage field, rejects partial evidence
split across sessions, and still rejects a 0.164 outcome. Five focused repetitions
passed. Captured terminal evidence also passes the full evaluator with the new
catalog; that replay does not regrade the original failure or replace a live smoke.

## Human feedback

Explicit user instruction on October 29, 2026: "it shouldnt expect any label
there". The change follows that instruction; no new provider-specific acceptance
requirement was introduced.

## Reusable lesson

Assert the state a provider-neutral task requires, not an implementation-specific
profile label. Metadata remains reported provenance, not independent remote
storage attestation. Full deployment smoke remains required after this fix.
