---
id: 2026-07-21-auto-rca-investigator-finished-without-publishing-pr
date: 2026-07-21
title: Auto-RCA allowed a 67-turn investigation to finish without invoking publish-draft
surface: infra
component: auto-rca
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Auto-RCA post-investigator lifecycle — PR publication depended solely on the model choosing publish-draft
symptoms:
  - production Auto-RCA completes 67 investigator turns with no pull request
  - the workflow has investigation changes but ends without a reviewable draft
  - the mandatory PR postcondition fails after the model stops
tags:
  - auto-rca
  - github-actions
  - pull-request
  - postcondition
  - agent-completion
sources:
  - PR #828
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

Production run 29802470978 completed 67 Claude turns and left useful
investigation changes, but the model never called `publish-draft`. The workflow
therefore ended with no PR despite PR creation being a required outcome.

## Diagnosis

The lifecycle treated a model tool choice as the only implementation of a
trusted postcondition. Nothing outside the model reconciled the final worktree
state with the required PR outcome, so a productive investigation could vanish
merely because its last action was not the publication tool.

## Solution

Add a trusted post-investigator fallback that preserves the investigation
changes and opens a preliminary draft with the incident and workflow links. Keep
the fallback outside the model's tool surface and retain the mandatory PR
postcondition.

## Human feedback

None recorded.

## Reusable lesson

Enforce required agent outcomes in trusted orchestration after the model stops;
never make a mandatory artifact depend only on the model choosing one tool.
