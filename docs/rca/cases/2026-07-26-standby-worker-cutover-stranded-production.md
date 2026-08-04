---
id: 2026-07-26-standby-worker-cutover-stranded-production
date: 2026-07-26
title: Agent workers booted in standby, so any cutover CI failure left production with zero pollers
surface: infra
component: agent-worker-cutover
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: self-driving worker deployment — new generations booted with require_activation=1 instead of polling their generation queue
symptoms:
  - every agent deploy strands production until workers are manually reactivated
  - a cutover npm install status post Temporal connection or timeout failure leaves zero pollers
  - surface-unchanged rolling restart exits without releasing standby workers
  - redeploying require_activation=0 restores production immediately
tags:
  - deploy
  - temporal
  - worker
  - standby
  - zero-downtime
sources:
  - PR #906
  - PR #907
repro: scripts/tests/workflow-deployment-migration.test.sh
status: fixed
---

## Problem

The self-driving cutover parked each deployed worker generation in standby.
Any later CI failure—dependency hydration, a missing status permission, polluted
CLI output, Temporal connectivity, or activation timeout—left the entire fleet
with no pollers and stranded every production agent until manual activation.

## Diagnosis

The design made worker availability depend on the success of a long,
multi-boundary activation transaction. That dependency was unnecessary because
each build already polls a surface-hash generation queue and can only replay
histories compatible with its own generation. Standby therefore removed
availability without providing compatibility safety.

## Solution

Boot workers live on `navi-agent-tasks@<surfaceHash>` with
`require_activation=0`. Make unchanged-surface cutover a pointer-read no-op and
changed-surface cutover a routing flip with rollback. CI failures can now leave
routing stale, but cannot remove every live poller.

## Human feedback

None recorded.

## Reusable lesson

Do not put fleet availability behind a fallible activation transaction when
workers can safely poll generation-isolated queues at boot.
