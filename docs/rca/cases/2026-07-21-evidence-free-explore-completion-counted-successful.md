---
id: 2026-07-21-evidence-free-explore-completion-counted-successful
date: 2026-07-21
title: Explore children that completed with no tool evidence counted as successful, blocking replacements until the parent hit its cost limit
surface: agents
component: explore-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: explore-child success accounting — an evidence-free completion consumed the successful-child budget while the child was still IN_PROGRESS
symptoms:
  - explore agent completes without any usable tool evidence and is treated as a success
  - replacement explore children are never spawned
  - parent agent loops until it hits its cost limit
tags:
  - explore-agent
  - spawn-agent
  - success-accounting
  - cost-limit
  - stall
sources:
  - PR #837
repro: agents explore-agent recovery/terminal regression coverage
status: fixed
---

## Problem

Explore children that finished without producing any usable tool evidence were
counted as successful while still sitting `IN_PROGRESS`. That consumed the parent's
successful-child budget, so no replacement child could be spawned, and the parent
kept looping until it exhausted its cost limit — an expensive stall with no useful
output.

## Diagnosis

Success for an explore child was inferred from completion rather than from evidence.
An explore run that returns nothing is a failure by intent — there is no data for the
parent to act on — but the accounting counted it, and worse, counted it while the
child's own state was still `IN_PROGRESS`. Two contracts disagreed: the budget
believed the slot was successfully used, and the recovery path believed no
replacement was warranted. With the escape hatch closed, the only remaining terminal
condition was the cost limit.

## Solution

Evidence-free explore completions are now treated as errors, so replacement children
can be spawned and the parent can actually recover. Only _usable_ tool evidence
counts toward success, and explicit explore failure reasons are preserved for the
parent and the UI rather than being flattened into a generic success. This also
prevents the sibling case of an explore child with no available data sources
masquerading as a completed exploration.

## Human feedback

None recorded.

## Reusable lesson

Define sub-agent success by the evidence it produced, not by the fact that it
finished — an evidence-free "success" silently closes the recovery path and lets the
parent burn to its cost limit.
