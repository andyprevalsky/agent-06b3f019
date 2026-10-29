---
id: 2026-10-29-agentcard-pause-cdp-collision-and-pending-hydration
date: 2026-10-29
title: AgentCard pause collided with attached CDP before replacement hydration stalled
surface: cross
component: browser-pause-resume
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Worker requested backend checkpoint while its DOMService retained the single CDP slot; later pending restore suboperation remains inferred
symptoms:
  - another client is attached to this session
  - Browser resume is still in progress
  - Timeout after 904s (task timeout=900s)
tags:
  - agentcard
  - tilion
  - checkpoint
sources:
  - PR #1627
  - commit b81ef3af99857012771aa7b53bf84f7a9c00d6fd
repro: python3 /var/tmp/deploy-1627/agentcard-g4-trajectory-rca/order-probe.py
status: open
---

## Problem

Agent941000ff-1f41-4497-9e8d-439457d662a9 remained ACTIVE at the900s AgentCard gate. Exact evidence and source hashes are in /var/tmp/deploy-1627/agentcard-g4-trajectory-rca/report.md and manifest.json.

## Diagnosis

At01:17:06 worker called backend close before local CDP disconnect. Backend checkpoint connection reported4409 at01:17:12; worker10s HTTP close failed01:17:16. Once worker disconnected after failure, backend attached and completed deletion. A source-extracted offline helper replay confirms capture->stop-recorder->backend-close with no detach. Replacement creation succeeds01:17:34, but receipt remains STARTED/hydrating; exact DB query sequence localizes pending work to context.setStorageState, without direct operation tracing. Installed Playwright uses kNoTimeout for that call. Underlying CDP operation and relation to the first collision are unproven. This differs from the earlier caught page.goto hydration failure; no current rejection completed, and ownership must not be cleared.

## Solution

Temporary candidate validated at the first boundary; integration and complete trajectory remain open. Narrow correction: passkey capture and recorder stop, then successful bounded exact-worker detach, then backend checkpoint/close, preserving original close-failure semantics and budgets. No source application, live reproduction, provider call or gate waiver. Existing runtime evidence plus offline source-order probe prove the first violation; they do not prove correction of later hydration. A future permitted investigation needs per-operation restore tracing. All saved evidence is read-only; original failed result remains failed. Full outcome is OPEN.

## Human feedback

Parent required10min read-only trajectory analysis, no provider/model calls or source/budget/assertion changes, and distinction from prior13RCA. Unknown stays unknown. Freedom and unrelated854d hold preserved.

## Reusable lesson

Transfer the exclusive CDP owner before backend checkpointing, and trace individual restore operations before attributing a still-pending hydration to a completed failure.


### Temporary first-boundary correction proof

The candidate at /var/tmp/deploy-1627/tilion-pause-order-rca/proposed.patch
(SHA256 b2176f8ad8c258a76ec40db8657bc2c14c9ff67f55a5e143abd2dfacb7cd6cf7)
adds an exact-current-Tilion pause-only transfer before backend checkpoint,
after passkey and recorder capture. Existing bounded detach must succeed;
false/cancelled detach never acknowledges approval. Other providers retain
their existing order. No lease, timeout, assertion, provider, or source mutation.

The identical new owning tests fail before and pass after: source-extracted
helper15controls, installed SDK actual write/payment activity6controls,
plus four unchanged original functions including real passkey/terminal
matrices. Five repetitions and exact commands are in repeat.sh and repeat-N.log
in that evidence directory. Original failure logs remain preserved. Provider
release remains backend-owned; failed close retains native/source and cleanup
receipt. Parent independent review and full integrated/live validation remain
open. The separate setStorageState pending operation is still UNKNOWN and
is not claimed fixed by this correction.
