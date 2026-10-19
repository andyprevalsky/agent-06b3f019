---
id: 2026-10-17-finalizer-cleanup-child-omitted-bound-credential
date: 2026-10-17
title: Finalizer cleanup child omitted the authority-bound credential
surface: infra
component: cloudbench-controller-payload-finalization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cleanup subprocess inherited ambient environment instead of the selected authority credential
symptoms:
  - no Fly credential is available
  - cleanup child joined with exit code 1
tags:
  - cloudbench
  - cleanup
  - credential-handoff
sources:
  - commit 447bf65e8e4f5b3faf8e02c695ac5f7411d24c39
  - fleet run original600-1792228733439245508
  - agent 01a137e6-c4c8-7691-a3dd-52540286a46c
repro: scripts/tests/cloudbench-controller-payload-finalization.test.py
status: fixed
---

## Problem

The run70 finalizer verified the export and invoked the canonical cleanup helper.
The child exited with `no Fly credential is available` before constructing its
API client. The finalizer itself had selected a credential from the hash-bound
agents input for monitoring, but its subprocess inherited only ambient variables.
The exact joined child and original cleanup intent were retained.

## Diagnosis

The saved traceback ends while evaluating the credential argument to the API
client constructor. The known helper and transport source prove that cleanup
dispatch and native API calls occur later. This is a positive pre-client failure,
not evidence that an unknown native write may be repeated. A focused regression
against the original finalizer finds no explicit child environment; the repaired
path supplies the same selected credential used by monitoring. An offline child
executes the production helper's credential boundary with a provider double.

## Solution

Read the complete agents input once, verify its authority hash, and use the
canonical token parser. Pass that token through the cleanup child's explicit
environment without exposing it in arguments, output, or new env files.

The explicit cleanup-refusal continuation accepts only the known source-bound
trace, a dead and positively joined child, the unchanged verified export, and no
native deletion/release markers. It preserves the original cleanup intent and
failed journal, rechecks the original supervisor/owner, and creates one exclusive
successor journal. All ordinary unknown cleanup attempts still refuse replay.
The actual run70 continuation on `1fc5b729ced76dda398f997650b8ba5d08eb522b`
completed with cleanup exit zero and canonical controller release verified.
The original failed child and cleanup intent remained intact; subsequent
archive-owned STOP also confirmed all 911 Machines stopped. This establishes
cleanup completion and does not change the failed benchmark outcome.

## Human feedback

Every fix must persist through the CLI so a fresh agent needs no manual aliases
or shell environment repair. Preserve the original clock, source and receipts.

## Reusable lesson

Pass selected credentials explicitly across a process boundary. A narrow retry
requires positive proof the failed process stopped before any external effect.
