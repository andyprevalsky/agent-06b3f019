---
id: 2026-11-11-preexecution-agentcard-election-had-no-admission-operation
date: 2026-11-11
title: Explicit AgentCard election could not omit unexecuted checks before admission
surface: harness
component: deploy-test-cycle-user-election
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: explicit user override is available only when adjudicating an existing pending failure
symptoms:
  - elect-user-omission is not an accepted cycle action
  - selected paid checks cannot be omitted prospectively without inventing failures
tags:
  - deploy
  - agentcard
  - user-election
  - evidence
sources:
  - PR #1915
  - commit 4bcda6aa9cb5b7df9467e7fd2940e6638c686dcb
  - plan: .context/rca-playwright/financial-election/verified-authority-reconciliation.json
repro: scripts/tests/deploy-test-user-omission.test.py::ProspectiveElection.test_cli_records_selected_six_without_fabricating_failures_or_changing_history
status: fixed
---

## Problem

The user explicitly elected to skip the local AgentCard lifecycle check and five
named payment smoke checks, and subsequently prohibited new paid AgentCard
operations. The existing typed override could adjudicate actual pending failures
but had no operation for a selected check that previously passed or had not run.
Creating a card to obtain a failure, inventing UNVERIFIED failure rows, editing
cycle state or silently removing checks would misrepresent that election.

The mass task is outside the six-check user scope. Its separately recorded
judge-quota exception remains separate. Read-only and mocked AgentCard tests
remain selected. Production retains its existing explicit skip election.

## Diagnosis

The actual owning CLI regression fails on the original cycle parser because
`elect-user-omission` does not exist. The existing override tests seed real
pending failures; they do not demonstrate prospective selection. The Claude
standing skip and historical sandbox custody imports are different contracts.
Primary native user-search, cursor-read and continuing-user-message artifacts
corroborate the exact existing election. Their original export gaps remain
explicit; an agent-authored attestation is not consumed as a grant.

## Solution

Add one typed, source/input/environment/plan-bound prospective election through
the existing exclusive cycle writer. Validate hash-pinned native authority and
the selected intersection of the exact existing six checks. Preserve attempts,
grades, unrelated pending failures and historical financial custody. Record
UNEXECUTED omissions in a separate ledger, with no native exit, assertion,
execution or financial credit. Existing no-retry custody takes precedence.
Reject active or unknown owners before admission; stale elections fail closed
until explicitly rebound. Do not create synthetic failure occurrences.

Independent review reproduced a native consumer mismatch: the real cloud
custody admission reconstructed custody without the prospective exclusions.
Reconstruct elections only after the original custody guard, retaining its
exact inventory comparison. New controls exercise that actual consumer without
provider calls and reject missing exclusions, active financial cases, foreign
mass skips and invalid custody. Malformed retained and authority containers
receive typed refusals without mutation.

The final unchanged positive regression was observed RED before applying the
source and the owning suite passed all 27 tests afterward. Independent review
closed both findings with the same admission and malformed-input controls.
These are fixture proofs of the election contract, not payment execution,
financial settlement or production acceptance. Normal frozen-source gates
remain required.

## Human feedback

The existing user election and prohibition are preserved. No new permission is
inferred from review approval or scheduled continuation. The last captured
sandbox obligation is $43.96 unreleased; current settlement remains UNKNOWN.

## Reusable lesson

Represent prospective user decisions separately from observed execution, and
test the actual admission consumer as well as the coordinator's projection.
