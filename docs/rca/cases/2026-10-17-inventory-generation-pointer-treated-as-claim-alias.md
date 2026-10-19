---
id: 2026-10-17-inventory-generation-pointer-treated-as-claim-alias
date: 2026-10-17
title: Inventory generation pointer was rejected as a claim alias
surface: infra
component: cloudbench-unused-reservations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench-unused-reservations.archive_members rejects the inventory publisher current pointer under its broad context/fleet alias guard
symptoms:
  - claim namespace contains an alias
  - context/fleet/runs/20261017-225357-1706/inventory/current
  - next77 read-only preparation failed before any provider operation
tags:
  - cloudbench
  - archived-reuse
  - inventory
  - symlink
sources:
  - commit 2aff0c25658a2938dc0a5a51f937b8d3bc6de663
  - commit 0000435cd1fab76a4285e7c97da6e8177eced026
  - fleet run original600-1792277195318370552
repro: python3 scripts/tests/cloudbench-unused-reservations.test.py
status: open
---

## Problem

The next77 read-only preparation stopped at `archive_members` with `claim namespace contains an alias`. The verified, unchanged Original76 archive contains exactly one symlink in the guarded namespace: `context/fleet/runs/20261017-225357-1706/inventory/current` targets `.generation-3ztqa28u`. Its manifest records the same link target. The target generation contains1830 physical file or directory entries and no nested aliases. No new benchmark, lease, configuration mutation or controller was started by the failed preparation.

## Diagnosis

The inventory publisher in `cloudbench-machine-readiness.py` builds a physical generation, creates a relative link to its generation basename, and atomically replaces `current`. That link selects read-only native observations. The unused-reservation reader instead classifies every alias under `context/fleet/` as ambiguous claim evidence, so it rejects this producer-owned pointer before examining reservations. The owning reproduction exercises full unused-reservation preparation and reproduces the exact alias rejection on the old2aff source. The same fixture passes with the reader correction. Source and manifest checks independently bind the observed pointer to the canonical producer.

Two full914-case archive searches used the exact alias error and the behavior terms `archive symlink generation pointer closed allocation absence`. No exact prior alias-error case was found. The mixed-reservation and shared-inventory cases are related but do not establish this failure's cause.

## Solution

The repair distinguishes the canonical inventory pointer from claim-bearing paths. It validates the exact pointer location, relative generation basename, matching manifest target, known producer source, physical containing directories and non-aliased generation membership. It never follows the pointer, creates claim evidence from cached observations, skips physical archive members or permits other claim aliases. The normal full archive and current-native checks remain mandatory. The existing unused-reservation owner passed21 tests in4.503seconds, including the old-source rejection and unsafe/escaping/missing/mismatched pointer and claim-alias negatives. A partial calibration of the actual1830-member manifest also passed, with zero capacity or claim credit. The complete actual read-only preparation has not yet been repeated on the composed repair; this case remains open pending that outcome.

The read-only reference search found a related pattern in OpenClaw: `src/infra/package-update-activation-immutable-pointer.ts:81` checks a physical generation identity and exact link target, while `src/infra/update-immutable-generation.ts:43` inspects physical entries and rejects escaping links. Searches of Claude Code, Hermes and Codex for inventory/current and generation-symlink patterns found no matching inventory-archive reader. The reference is a design analogy, not a substitute for this archive's proofs.

## Human feedback

None recorded for this failure. The existing requirement to preserve old evidence and ownership checks remains in force.

## Reusable lesson

Model producer-owned observation pointers separately from mutation and claim evidence while continuing to validate every physical archive member.
