---
id: 2026-07-24-runner-disk-exhaustion-lost-unpushed-rca-checkpoint
date: 2026-07-24
title: Hosted-runner disk exhaustion hard-crashed Auto-RCA and lost its unpushed retry checkpoint
surface: infra
component: auto-rca
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Auto-RCA checkpoint durability — investigator commits remained local until after trusted verification
symptoms:
  - a 71-minute Auto-RCA revision exhausts hosted-runner disk
  - the worker hard-crashes during the retry investigator
  - locally committed retry work disappears after the runner dies
  - recovery restores Slack and PR binding but not the lost checkpoint
tags:
  - auto-rca
  - github-actions
  - disk-exhaustion
  - checkpoint
  - durability
sources:
  - PR #889
repro: scripts/tests/auto-rca-lifecycle.blackbox.test.sh
status: fixed
---

## Problem

Production run 30071452339 progressed through `/RCA` and into `/deploy`, then
the hosted runner exhausted disk after 71 minutes. The worker hard-crashed and
discarded a locally committed retry checkpoint; reconciliation recovered the
workflow binding but could not recover work that was never pushed.

## Diagnosis

Runner exhaustion was the trigger, but the owned durability defect was delaying
checkpoint publication until after trusted verification. A local commit on an
ephemeral worker is not a durable checkpoint, so any host death before the push
boundary erased completed model work.

## Solution

Reclaim unused hosted toolchains before hydration, avoid retaining package
download caches, log disk headroom, and push both investigator checkpoints
before trusted verification. Also retain known affected-user identity across a
transient lookup failure.

## Human feedback

None recorded.

## Reusable lesson

Persist agent checkpoints off an ephemeral runner before expensive verification;
a local commit is not durable against host exhaustion.
