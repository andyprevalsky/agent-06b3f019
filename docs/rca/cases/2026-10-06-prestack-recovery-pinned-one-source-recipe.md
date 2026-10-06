---
id: 2026-10-06-prestack-recovery-pinned-one-source-recipe
date: 2026-10-06
title: Pre-service recovery could not validate a newer immutable source recipe
surface: infra
component: cloudbench-prestack-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: verify_bootstrap required one historical source ref and a stack log even for genuine pre-stack cancellation
symptoms:
  - exact stopped task-free canaries remained quarantined after controller exit
  - newer clean source did not match the historical bootstrap attestation
  - one genuinely acknowledged cancellation had no stack log
tags:
  - cloudbench
  - prestack-recovery
  - source-binding
  - cancellation
sources:
  - PR #1422 follow-up
  - commit 8ed0c776d351e5bbd86494646871d5c676e5a2cc
  - fleet run 20261006-180741-40762
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py
status: mitigated
---

## Problem

The failed fifty-copy preflight allocated two task-free infrastructure canaries.
The original supported recovery refused their incomplete normal runtime seals.
Both guests were stopped and their original volumes captured through inert
boots, with exact original configurations restored afterward. One guest had an
original cleanup ACK but never launched its stack; the other stopped during
isolated database index bootstrap without launching application services.

Neither guest executed a benchmark. Their native allocation-to-destruction
lifetimes were 1,657 and 1,685 seconds, exceeding this diagnostic's 1,200-second
cutoff. Both therefore retain zero acceptance credit. Original bytes and
source/native receipts remain private under
`.context/fresh-basic-claude-final50-20261006/`.

## Diagnosis

Archive searches covered prestack recipe/source rejection and absent stack
logs. The
[child-token case](2026-10-04-pool-recovery-rejected-child-shutdown-token.md)
concerns receipt identity, and the
[runner-before-stack-cleanup case](2026-09-29-runner-receipt-accepted-before-stack-cleanup.md)
concerns promoting a narrower runner receipt. These related cases do not
establish pre-service absence for a new source recipe.

The bootstrap validator encoded a single historical Git ref and source hash.
It also required a stack log for the only supported bootstrap shape. The
current clean native ref and a genuine earlier cancellation could not satisfy
those predicates. Accepting their owner token alone would have repeated the
older unsafe receipt-promotion defect.

The actual unchanged original-volume captures failed on the original validator
and passed after a source-bound extension. Independent review bound all fifteen
packed executables, three boot controls, checkout helpers, original execution
provenance, archive contents and native configuration. A first draft checked
only the driver/fetch pair; review required binding every actual executable.
The pre-stack and index-bootstrap phases were reviewed separately against their
captured source. No review of an unobserved later phase was borrowed.

## Solution

The permanent validator derives the immutable source recipe from the exact
native full Git ref and captured clean checkout, instead of a named historical
commit. Every injected executable and canonical script input must match that
recipe. Publishing or reusing the separate bootstrap receipt requires an
independent review binding the same ref, recipe hash and pre-service phase.
No actor name or historical ref bypasses this review.

A pre-stack cancellation requires its genuine original ACK and proven stack-log
absence. Index-bootstrap cancellation retains its original exited state,
descendant/service absence and source-phase checks. The receipt never becomes
a synthetic guest ACK, provider manifest or benchmark result. Normal exact
recovery still verifies native Machine and volume release.

The reviewed zero-credit native recovery finished in 63.780 seconds. Exact
provider GETs returned both Machines destroyed and both unattached volumes
pending_destroy. The owning registry and claims were absent; all thirty-five
baseline Machines and fifty baseline volumes, the stopped donor configuration,
and an unrelated new Machine were preserved. This completes recovery of the
failed attempt, not the fresh fifty-copy execution goal.

Nineteen generic owning controls passed, including every injected-executable
mismatch, missing/mismatched independent review, source-phase crossing and
original ownership inverses. The thirteen existing message-person prestack
controls passed unchanged. These scripts already run in the normal deploy
structural gate. Root applied the sealed permanent candidate and independently
reran all nineteen controls successfully in 30.259 seconds.

This recovery boundary supports clean committed recipes whose exact Git objects
and complete immutable capture inputs remain available. Uncommitted worktree
patches and incomplete historical captures still fail closed. Fresh fifty-copy
execution and deadline proof remain outstanding; status is mitigated.

## Human feedback

The user required exact resource release, zero credit for interrupted recovery,
autonomous completion, stable CLI instructions and compact permanent regression
coverage in deployment. Preserve working setup and unrelated resources; do not
make a separate cybersecurity investigation a prerequisite.

## Reusable lesson

Bind recovery to the actual immutable source and independently reviewed execution phase rather than a historical commit or a fabricated completion receipt.
