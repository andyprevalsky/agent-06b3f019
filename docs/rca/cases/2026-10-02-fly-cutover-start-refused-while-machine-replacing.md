---
id: 2026-10-02-fly-cutover-start-refused-while-machine-replacing
date: 2026-10-02
title: Fly cooperative cutover issued one start per cloned machine, so starts refused while the update was still replacing the VM left the new generation at 4/8
surface: infra
component: deploy-agents-cooperative-cutover
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy-agents-cooperative-cutover.sh configure_new_machine — `flyctl machines start ... || true` ran once right after `machine update --skip-start`, and the health wait loop only counted started machines and never re-issued a start
symptoms:
  - "failed_precondition: machine getting replaced, refusing to start"
  - "only 4 / 8 new-generation machines started; refusing to flip the queue pointer"
  - "deploy-agents cooperative cutover failed: failure"
tags:
  - deploy
  - fly
  - cutover
sources:
  - PR #1357
  - commit ed1860f3db140dd060d21f3138bf01a008480ef7
repro: scripts/tests/deploy-agent-clone-recovery.test.sh
status: fixed
---

## Problem

The production Fly rollout for merge `ed1860f3` failed before the queue pointer flip. Eight new-generation machines were cloned and updated, but four of them logged `failed to start VM ...: failed_precondition: machine getting replaced, refusing to start`. The wait loop then reported `new-gen started=4 / 8` for 300 seconds and the script exited with `only 4 / 8 new-generation machines started; refusing to flip the queue pointer`. Production stayed on the previous generation, so this was a stuck rollout, not an outage.

## Diagnosis

`configure_new_machine` runs `flyctl machine update --skip-start` and then immediately `flyctl machines start`. Fly is still replacing the VM for the update when the start arrives, and it refuses with `failed_precondition`. That start is wrapped in `|| true`. The health wait loop only counted machines already `started` and never issued another start, so a refused start could never recover. The deepest owned cause is that the script treated a single start request as sufficient, but Fly's machine state is eventually consistent after an update. Commit 8187535a6 added retries for the update call but left the start as fire-once.

Local repro: the fake Fly in `deploy-agent-clone-recovery.test.sh` now refuses the first N starts with the same error. On the old script, the new `run_case 0 old 0 4` case hangs until the 300 s deadline and then fails, the same as production.

## Solution

The wait loop now reads the new-generation machines' states with one `machines list` per tick. It re-issues `machines start` for any machine that is `stopped` or `created` until all of them are `started` or the 300 s deadline passes. Starting a stopped machine of the target generation is idempotent. The deadline still fails closed before the pointer flip, so a machine that keeps crashing still blocks the cutover. The loop also replaces N+1 `machines list` calls per tick with a single call.

## Human feedback

The user directed that `/deploy` be carried through to production verification.

## Reusable lesson

After any control-plane mutation on an eventually consistent provider, converge on the observed state by re-issuing the idempotent action until a deadline, rather than issuing it once and only polling.
