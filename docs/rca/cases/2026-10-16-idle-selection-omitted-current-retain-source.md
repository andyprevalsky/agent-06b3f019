---
id: 2026-10-16-idle-selection-omitted-current-retain-source
date: 2026-10-16
title: Idle cleanup omitted an available current RETAIN source
surface: harness
component: cloudbench-resource-selection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: root candidate selection used the historical 19 plus 47 protection subset without the available V41 owner evidence
symptoms:
  - A known RETAIN Machine entered the user-directed idle STOP selection
  - Current owner protections were absent from the frozen exclusion overlay
tags:
  - cloudbench
  - cleanup
  - ownership
  - protection
sources:
  - PR #1525
repro: python3 scripts/tests/cloudbench-protected-resources.test.py
status: open
---

## Problem

The 108-Machine cleanup stopped `84910df24d2168`, despite available V41
evidence marking its owner RETAIN with incomplete runtime evidence. The native
quiescence check passed and STOP was confirmed; neither permits overriding a
protection record. IDs, configuration, volume and data were retained. No blind
restart, deletion, reuse or benchmark credit is authorized by that outcome.

## Diagnosis

The first bad boundary was the root selector's input set. It froze 19 protected
identities and 47 historical retained clones but omitted the already available
V41 registry/audit evidence. The later native probe cannot repair that selection
error. Replaying the actual frozen candidate against those two inputs includes
it; replaying against the union of all eleven available source files excludes
it. The private incident preserves both results and original source hashes.

Archive searches were `RETAIN protection selection` and
`idle cleanup protected ownership`. The September 11 local cleanup ownership
case is related, but concerns process discovery rather than an incomplete
resource-policy input set.

## Solution

Add an exclusion-union helper for the existing identity roster, retained-clone
roster, owner ledgers, current match evidence, and captured registry/claim files.
Any RETAIN policy, live latch, claim, hold or incomplete owner policy excludes
the corresponding identity, volume or name. A permissive record cannot erase
another source's exclusion. Unsupported or missing required source files fail
before producing a selection. The result is only a protection index and gives
no cleanup or admission authority.

The root's replacement input manifest records all eleven available source files
and their hashes. Applied to the existing 708 candidates, the union selects 619;
the fresh inventory finds 607 stopped and 12 started. These counts are candidate
counts, not idleness, snapshot availability or benchmark qualification.

## Verification

Seven registered tests passed five unchanged runs. They cover the actual V41
identity, conflicting REAP and RETAIN records in either order, heterogeneous
volume/owner sources, captured registry/claim records, and incomplete sources.
The actual local selection replay proves the historical subset included the
protected identity and the full source union excludes it. No provider calls
were made by these tests. The operational incident remains open; preserving the
data and correcting future selection does not undo the inappropriate STOP.

## Human feedback

Protect RETAIN and active-consumer resources before dispatch. A dated subset is
not a complete current protection set. Do not repair an ownership error by
blindly restarting or deleting the affected resource, and do not claim reuse
or task success from its stopped state.

## Reusable lesson

Combine all available protection sources before selecting resources. Keep
conflicts conservative, reject ambiguous policy records, and bind nested holds
to their owner instead of assuming every hold is a leaf file.
