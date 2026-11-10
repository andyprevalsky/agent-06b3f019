---
id: 2026-11-07-deploy-coordinator-disappeared-before-native-finalization
date: 2026-11-07
title: Deploy coordinator command ended143 while isolated native workers continued
surface: harness
component: staged-deploy-coordinator-finalization
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: executor reports command status143 before the coordinator records final round30 receipts
symptoms:
  - Unified executor session4050 returns exit143
  - Isolated native worker supervisors survive reparented to PID1
  - Original final requests have terminal native results but missing coordinator receipts
tags:
  - deploy
  - interrupted-coordinator
  - native-evidence
sources:
  - PR #1716
repro: .context/pause-rca/nov7-coordinator-loss/REPORT.md
status: open
---

## Problem

Gate: UNKNOWN. At 08:57:19 UTC on November 7 the executor reported status143
for the command running the `ed47d406` final coordinator. No matching machine
memory-termination entry exists. The Python coordinator's actual wait status,
signal sender and causal mechanism are unknown. Owned native supervisors
continued and later produced their original results. No causal reproduction
of the executor termination is claimed.

## Diagnosis

The retained executor trace binds the command and end time but lacks the raw
runtime payload establishing a sender. Source inspection bounds signal-capable
fixture paths without attributing delivery. The observed missing interrupted
attempt differs from a completed normal cancellation path; it does not exclude
an unobserved second signal or other termination layer. Earlier timing-context
setup refusals are a separate, proven boundary.

## Solution

Preserve the original source, requests, six existing receipts, three existing
failure IDs and UNKNOWN coordinator facts. Actual owned-supervisor sidecars
provide native wait statuses and closure. A prospective kernel observer bound
the still-live smoke producer's PID, birth, boot, request and pidfd, then captured
its actual exit0; owned exit0/7 and malformed/identity negative controls verify
that distinct authority. It is not a retrospective supervisor sidecar.

An independently reviewed ignored operator completed an exclusive, journaled,
idempotent NONPASS finalization of the original round30. It checked actual
source, environment, qualification, recipe, native result and owner closure;
all positive missing finalizations remain UNVERIFIED, actual FAIL remains FAIL,
and ready remains false. Original receipts and failure IDs are unchanged.
The committed marker, journal hash, exact after-state and every new output
were verified before normal operations resumed. No success was reconstructed
from cleanup or unavailable coordinator flags and clocks.

Production guards now reject recovered receipts from full-pass reuse, require
explicit false lifecycle flags for ordinary pass credit, and fence normal
actions behind an unfinished recovery journal. Registered positive/negative
tests reproduce the previous guard acceptance and verify the correction.
This protects recovery semantics; the original termination cause stays open.
All affected failed or unverified gates require ordinary native execution.

Approval: not applicable (no approval-gated hunk).

## Human feedback

The user required finishing deployment autonomously. Independent review
clarified the safe order: preserve source pins during the serialized NONPASS
transaction, verify completion, then add guards before normal entrypoints.

## Reusable lesson

Keep native execution authority separate from a coordinator's bookkeeping.
Recover honest nonpassing state when original coordinator facts are absent;
do not manufacture a pass or a historical process-join record.
