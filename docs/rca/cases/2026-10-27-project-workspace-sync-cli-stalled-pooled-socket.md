---
id: 2026-10-27-project-workspace-sync-cli-stalled-pooled-socket
date: 2026-10-27
title: Project workspace fixture blocked pooled socket cleanup during its CLI child
surface: harness
component: project-workspace-blackbox
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Synchronous networked CLI subprocess blocks parent Undici pool from processing an idle socket close before subsequent GET
symptoms:
  - "PJ4 seed-rose fetch failed at project-workspace.blackbox.ts:419"
  - "UND_ERR_SOCKET other side closed in controlled native reproduction"
tags:
  - test-fixture
  - event-loop
  - child-process
  - pooled-socket
sources:
  - commit 46bfbfb5f3f33e273fefbbf0fc560cf9a3e00277
  - plan:.context/deploy-fresh-20261027/rca-project-workspace/native-summary.json
  - plan:.context/deploy-fresh-20261027/rca-project-workspace/assertion-receipt.json
repro: back-end/src/tests/blackbox/project-workspace.blackbox.ts (PJ4 post-seed GET and real-child event-loop control)
status: open
---

## Problem

PJ4's post-seed GET failed with fetch failed in the native backend gate at46bfbfb5. The original nested cause was not printed. Other project cases and backend requests continued.

## Diagnosis

A controlled6500ms delay only at seed-rose child startup reproduces the exact failing GET with native UND_ERR_SOCKET. Independent backend socket events show the idle connection closed while the synchronous parent was blocked; the resumed parent attempted that exact socket. This is a controlled causal reproduction, not a reconstruction of missing original timing.

## Solution

Applied exact reviewed test-only async execFile ownership for all four rose-sync CLI invocations, preserving captured streams, exit-code checking, all51 existing assertions and original deadlines. Add a real-child heartbeat/output/nonzero-status control. Native corrected command passes all5 cases under the same delay. Reverting the helper makes both PJ4 and the new control fail. The coordinator applied the reviewed candidate SHA256 `941da667e4742cf6f581e95969ef1b1a566a06f11d41f58dd36ece08a73858e7`. Full combined acceptance remains pending.

## Coordinator constraints

No speculative retry or server timeout change. Preserve original assertions, secret scanning, fixture contents, ownership and cleanup. Shared source, archive and INDEX are coordinator-owned. Root's original socket hypothesis was treated as unproven until controlled native evidence existed.

## Evidence

REPORT.md and native-summary.json in this scratch directory contain exact commands, hashes, socket timestamps, original limitations and cleanup. The exact owned database was dropped after all connections and native children joined. No production or external provider call ran.


## Human feedback

No additional user feedback was recorded. The coordinator required proof for the socket hypothesis before application and preserved all deadlines and HTTP semantics.

## Reusable lesson

Await networked fixture subprocesses without blocking the parent event loop; let transport lifecycle events drain before subsequent pooled requests.
