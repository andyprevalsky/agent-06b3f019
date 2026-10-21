---
id: 2026-10-21-explicit-e2e-budget-rejected-fixed-startup-reserve
date: 2026-10-21
title: Explicit original 9300-second budget rejected instead of bounding startup
surface: infra
component: cloudbench-original600-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: campaign_timeouts requires fixed startup allowance even for explicit caller e2e budget
symptoms:
  - explicit 7200/9300 same-CLI rerun refused before launch
  - full-window default fix interpreted as a mandatory minimum for every explicit budget
tags:
  - sharded
  - e2e-timeout
  - start-barrier
  - same60
sources:
  - commit c16613a57433303dc0e5ac29d98567ff8274982b
  - commit 507da9dfcfe47c064ac944d786fd8e4748fe537b
repro: scripts/tests/cloudbench-shard-coordinator.test.py ExplicitBudget
status: open
---

## Problem

The original SAME60 producer argv binds a 7200-second task allowance and
9300-second shared admission-to-end deadline. The full-window default fix
507da9dfc correctly includes 1620 seconds startup and 1200 seconds post-task,
but its validator consequently refuses the explicit original command.

## Diagnosis

At c16613a5, the identical owning controller assertion
`campaign_timeouts(7200,9300)==(7200,9300)` raises ValueError demanding 10020.
The original default failure remains real: recorded barrier release took
1350.6 seconds, so that run cannot fit a full task and 1200 seconds post-task
inside 9300. The explicit request is feasible only when startup finishes within
9300-7200-1200=900 seconds; it is not feasible by pretending the larger default
startup allowance fits. Searches: `e2e barrier budget`, `startup deadline
admission`. Read related full-window-default and pre-supervisor-cleanup cases.

## Solution

Keep default_e2e_timeout and the full 1200-second post-task allowance. Accept
an explicit e2e only if it leaves positive startup time. Derive a shared
absolute startup cutoff from original epoch+e2e-task-post. Bind host admission,
spawn/retry and coordinator release to that cutoff. The checked supervisor
passes the same absolute cutoff to the remote campaign, which converts it to
monotonic time once and checks it before local task release, including after
waiting for an external barrier. Startup expiry interrupts and joins an active
canary/seed through existing cleanup, without shortening task or cleanup clocks.

Owning registered controller controls fail before and pass after; the real
remote release function previously wrote release.json after expiry and now
writes abort.json. The actual campaign subprocess previously launched tasks
with an already-expired startup fence and now admits none; active-canary expiry
waits for CANARY_JOINED. This is local causal/contract evidence, not proof that
60 live guests can become ready in 900 seconds, or original task outcome proof.
The old 1350.6-second startup would now abort before task launch.

## Human feedback

The user requires the exact original 7200/9300 CLI, no bound increase, no
reduction of the task allowance, and preservation of the default full-window
fix. They require independent changed-byte review before integration and no
benchmark or provider allocation yet. Freedom and protected instructions,
other worktrees, launch branch, and shared STATE remain unchanged.

## Reusable lesson

A safe default allowance is not a mandatory minimum for an explicit deadline:
derive the remaining startup budget and refuse late release, preserving the
full execution and post-task windows rather than extending the caller's clock.
