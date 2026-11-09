---
id: 2026-11-09-post-cleanup-fixture-mixed-current-bytes-with-historical-pins
date: 2026-11-09
title: Synthetic post-cleanup history returned current producer bytes under old pins
surface: harness
component: scripts/tests/deploy-test-cycle.test.py
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: post55_fixture mocked historical source_bytes with current checkout bytes while leaving historical producer pins active
symptoms:
  - 'backend post-execution cleanup: original producer changed'
  - post-cleanup negative controls failed before reaching their intended predicate
tags:
  - deploy
  - cleanup
  - source-pins
sources:
  - commit 8914dd02e1f424c0345ce70752d791f8426070a6
repro: python3 scripts/tests/deploy-test-cycle.test.py LocalCleanup
status: fixed
---

## Problem

The full coordinator suite failed post-cleanup fixture cases at `original
producer changed`. The positive setup used a synthetic historical head, while
its source reader returned today's checkout bytes. Main had changed two of the
seven pinned producer files. All seven actual historical source blobs still
matched the production pins, so the validator correctly rejected the fixture's
incoherent source construction.

## Diagnosis

The first bad boundary was the fixture reader, before the intended domain,
recipe, observer and skip-negative predicates. Production pins and historical
source authentication were correct. The same five owning methods failed against
the original fixture and passed unchanged with coherent construction. Read-only
historical comparison distinguished the two changed current files from the seven
valid old producer blobs; no production source map was widened.

## Solution

The fixture now snapshots its producer bytes and computes a matching,
test-scoped pin map. Its mocked reader asserts the exact synthetic root and
head, then returns those snapshots. Context-managed patches restore the actual
production pins after the test. This keeps the test hermetic in a fresh or
shallow checkout; it does not require an old branch object. The existing
changed-producer negative still rejects drift. Assertions, timeouts, validator,
auditor and production pins remain unchanged.

Independent review cleared the exact fixture-only hunk. The original full-suite
failure and owning RED/GREEN supervisor receipts remain in private deploy
evidence. This correction grants no native cleanup or full-gate credit; the
complete coordinator and final-source gates are separately required.

## Human feedback

No new human feedback. Independent agent review covered the fixture only.

## Reusable lesson

A synthetic history must pair its declared identity with coherent immutable
bytes and hashes. Do not authenticate today's checkout as an older producer.
