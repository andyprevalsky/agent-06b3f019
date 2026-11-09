---
id: 2026-10-21-phone-optional-verification-target-rejected-null
date: 2026-10-21
title: Phone action validator rejected an explicitly null optional verification target
surface: agents
component: browser-phone-schema
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: PhoneBrowserTool.validate_mode treated field presence as a nonempty verification target
symptoms:
  - verificationTarget requires setup verify
  - Explicit null was rejected although omission and the generated schema allowed it
tags:
  - phone
  - schema
  - validation
sources:
  - memory: .context/phone-harness/phone-null-final-assertions-red.log
  - memory: .context/phone-harness/phone-null-final-assertions-green.log
repro: agents/tests/blackbox/rose_browser_use.blackbox.py
status: fixed
---

## Problem

The generated phone schema declares `verificationTarget` optional and nullable.
A setup block action with that field omitted normalized successfully, while
the equivalent action with explicit null raised `verificationTarget requires
setup verify`. This affected a boundary before any phone operation.

## Diagnosis

Path: structured tool arguments -> phone normalization -> PhoneBrowserTool ->
validate_mode -> validated action. The validator checked membership in
`model_fields_set`, which includes explicit null, instead of checking whether
a verification target was supplied. The declared schema and runtime validator
therefore disagreed. Searches for `verificationTarget requires setup verify`
and `nullable optional schema field rejected` found related schema-contract
cases but no exact recurrence; the readiness case and process feedback were
reviewed.

The existing registered owning schema test compares normalization of null and
omission. With the old presence guard it failed (8/9 selected cases); replacing
it with the non-null value guard made the identical assertions pass (9/9).
The test retains rejection of every non-null target on the wrong mode/action.
This is a directly reproduced contract bug. A separate real-model failure did
not preserve its raw arguments, so it is not proven to be this exact instance.

## Solution

Guard the target's non-null value before restricting it to setup verification.
Do not discard invalid non-null targets, relax action validation, or add a
retry. The generated schema, optional default and normalization now agree.

## Verification

The exact selected registered command and before/after output are recorded in
`google-policy-python-full-result.json`, with logs
`phone-null-final-assertions-red.log` and
`phone-null-final-assertions-green.log`. Six disabled-path golden contracts,
actual disabled HTTP request, non-null negative cases, Ruff, compile and diff
checks pass. An earlier wider Rose run was 113/114 due to a saved-password model
decision; this nullable guard did not fix that outcome. After isolating optional
policy context and describing the existing verification-only constraints,
final Rose passed 114/114 and all four policy planner controls passed. Those
separate changes and fixture corrections are recorded in the readiness case. A subsequent synthetic
raw capture showed a distinct rejected combination: setup block with non-null
verification target and evidence IDs. That remains correctly invalid; it is
not an instance of the fixed null bug.

## Human feedback

The user requires the conditional Workspace exception during boot, while
preserving normal trajectories and existing security boundaries. No schema or
test assertion was weakened to accept an invalid non-null target.

## Reusable lesson

Validate the value of a nullable optional field when its absence and null carry
the same semantics; preserve the restrictions for actual supplied values.
