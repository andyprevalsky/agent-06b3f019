---
id: 2026-10-06-sealed-snapshot-inverse-required-owned-fixture-write-permission
date: 2026-10-06
title: Normal snapshot policy tamper control assumed its generated fixture was writable
surface: harness
component: cloudbench-bootstrap-recovery-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the snapshot inverse called policy.write_bytes before making its exact generated readonly fixture writable
symptoms:
  - PermissionError at the generated cloudbench-prestack-source-reviews.json
  - normal snapshot positive and foreign-source rejection completed before the error
tags:
  - snapshot
  - readonly
  - fixture-isolation
sources:
  - PR #1424
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py
status: open
---

## Problem

The registered deploy structural lane ran 24 bootstrap recovery controls and
reported one error. The normal controller snapshot control successfully
published and validated its source-bound zero-credit recovery receipt, then
rejected a foreign source. It raised PermissionError when trying to alter the
snapshot policy for its existing tamper-and-reseal inverse.

## Diagnosis

The reviewed source policy in the isolated deployment tree had mode 0444. The
normal fleet copy retained its owner-readonly mode; the private runner's 0077
umask also removed group and other read bits. The prior independent source
mirror had mode 0644, so that same inverse could write its generated copy.
The first bad boundary was the fixture's implicit write-permission premise,
not the runtime recovery validator. No recovery predicate or immutable source
policy needed weakening.

Archive searches covered PermissionError, readonly snapshot, and the normal
controller snapshot control. The same-day prestack source-recipe case is a
relative: it explains the source-bound cleanup predicate, but does not cover
this generated-fixture permission assumption.

The unchanged one-case native control failed in 3.890 seconds. The repaired
control passed in 3.517 seconds, using the actual normal controller --help
snapshot path without any benchmark, provider allocation or model call.
Earlier private adapter and mode-comparison mistakes remain rejected attempts.
The other 23 recovery controls have unchanged Python syntax trees. The source
policy's original bytes and mode stayed unchanged.

## Solution

After the ordinary positive and foreign-source inverse, explicitly exercise a
readonly generated policy. Make only that controller's generated policy and
manifest owner-writable for the existing tamper-and-reseal inverse. Preserve
its rejection assertions and exact native controller/snapshot retirement, and
assert the original committed source policy's bytes and mode are unchanged.

The owning control remains registered in the existing deployment structural
runner. Independent source review passed; final normal registered deployment
qualification is pending, so this case remains open. These fixture results
carry no benchmark or recovery acceptance credit.

## Human feedback

The user required actual normal CLI paths, complete private evidence and
unchanged source-bound cleanup semantics. The repair preserves production
snapshot ownership and changes only the deliberately tampered private fixture.

## Reusable lesson

A rejection fixture that intentionally changes a sealed copy must declare its own write permission and preserve the original source.
