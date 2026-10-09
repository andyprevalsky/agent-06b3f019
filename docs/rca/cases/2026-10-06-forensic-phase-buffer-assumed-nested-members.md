---
id: 2026-10-06-forensic-phase-buffer-assumed-nested-members
date: 2026-10-06
title: Phase buffering rejected valid single-segment archive members
surface: infra
component: cloudbench-forensic-retirement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the archive read loop unpacked every preserved member as a task and relative path
symptoms:
  - valid preserved metadata raised not enough values to unpack
  - phase originals rebuilt the accumulated bytes on every block
tags:
  - cloudbench
  - forensic-archive
  - exact-owner-recovery
  - buffering
sources:
  - PR #1424 review comment 4202918167
  - commit c214f5199646cb3bb51a81ef243df8ee01991536
  - plan:.context/fresh-basic-claude-final50-20261006/deploy/c4-review-cycle1-owning-fixes.private/forensic-v2-original-red.safe.json
repro: scripts/tests/cloudbench-forensic-quiesced.test.py::PreServiceArchiveTest.test_generic_archive_accepts_valid_single_segment_preserved_metadata
status: open
---

## Problem

The manifest contract accepts safe preserved names starting with an underscore,
including `_note.json`. Phase-original buffering nevertheless unpacks every
archive member as two slash-separated components. A valid manifest is rejected
before archive readiness can be established. Accumulating each phase file with
immutable byte concatenation also recopies the complete prefix on each block.

## Diagnosis

An actual existing generic verifier fixture adds one valid preserved metadata
member, with unchanged ownership, hashes and native inventories. Unchanged
source raises `ValueError: not enough values to unpack` at the member split.
The same command's multi-block original-file inverse passes. The source-bound
two-state command took 5.949 seconds; its native leader and group are absent.

Archive searches used `not enough values to unpack manifest preserved_files`
and `archive verification quadratic phase buffering`. The mixed-runtime
archive case is a relative: it owns phase and allocation classification, not
this member-name parsing boundary. Earlier private-copy runs that lacked the
trusted helper location or a valid snapshot were setup failures and retained
with no causal credit. The qualified pair uses an isolated Git checkout and
the unchanged committed source-policy contract.

## Solution

Parse one optional separator and buffer only actual task-relative phase files.
Valid preserved leaf metadata remains digest-verified without entering a task
buffer. A single mutable byte buffer accumulates blocks, followed by one final
conversion. The existing 64 MiB phase-file limit remains enforced before
buffering; archive member, total-byte, digest and ownership checks remain.

The identical two states pass in 6.212 seconds. The multi-block inverse checks
the exact complete original bytes delivered to the existing phase verifier,
then invokes that original verifier and requires exactly one invocation. There is no
elapsed performance assertion or measured production speed claim. The existing
earlier full forensic suite passed all 15 states in 46.110 seconds with its
native leader and group absent. The strengthened two-state pair proves the
consumer receives exact original bytes. Final normal registered gate
qualification remains mandatory.

Archive readiness still reports zero proof credit and
`native_release_verified=false`. Ordinary exact reaping and final native
absence remain separate obligations. No original run, result, provider,
volume, active trial or source-policy entry is changed. This is bounded work
over one retained archive, outside live agent execution; it adds no fleet-wide
lock or per-agent request.

## Human feedback

Preserve truthful originals and exact terminal resource release. Usable stage
handoffs are the verification boundary; do not add microscopic speed criteria
or turn an archive-ready receipt into a resource-closure claim.

## Reusable lesson

Every accepted manifest shape must survive its read consumer; accumulate
bounded evidence once without changing its digest or ownership authority.
