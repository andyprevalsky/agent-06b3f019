---
id: 2026-10-18-acknowledged-claim-lacked-readback-recovery
date: 2026-10-18
title: Acknowledged archived claim had no bounded readback recovery
surface: infra
component: cloudbench-archived-machine-reuse
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: allocate propagated the inactive-observation deadline after a successful claim update without using the existing same-claim readback path
symptoms:
  - ObservationDeadline during durable native response recording
  - successful claim update and inactive readback without claim acknowledgement publication
tags:
  - cloudbench
  - native-observation
  - recovery
sources:
  - commit c9d4817832720cc2b1bc6a212383973a77baf004
  - fleet run original600-1792279176545861179
  - task r003-j0546 browser-alchemy-springs-sauna
repro: python3 scripts/tests/cloudbench-archived-machine-reuse.test.py Tests.test_allocate_deadline_retains_failure_and_reconciles_once_without_cas_replay
status: open
---

## Problem

Original77 reached worker startup. Task r003-j0546 failed while observing its archived Machine claim. The ten-second complete observation window expired inside response-journal fsync. The original failure, source, task and clock remain unchanged. This case covers that startup boundary; the final run's other infrastructure classifications require its complete export.

## Diagnosis

The captured claim subtree contains 33 files and 2,305,633 bytes. Its transport archive SHA256 is cedfe1ee03d2002ca29e920678c8606ff0afbf9feab3e9f7e185734e91a9a031. Independent validation checked every file hash and found one version-fenced configuration POST200, an exact new-incarnation stopped GET200 and the same-lease DELETE200. The post-GET result file and claim-ack were absent.

The GET's HTTP-start to raw-receipt timestamp was 9.612402558 seconds against a 9.734033504-second request allowance. This proves neither that fsync alone took ten seconds nor that durable observation completed within the original window. The timeout must remain a timeout. The missing mechanism was a bounded way to obtain fresh proof after that uncertain observation without repeating the accepted configuration write.

## Prior archive search

Searches used `ObservationDeadline inactive native observation deadline fsync` and `acknowledged configuration timed out durable readback startup`. Related cases are `2026-10-17-capacity-timeout-covered-local-archive-proof` and `2026-10-16-process-scan-swallowed-observation-deadline`. Their fixes separate unrelated archive work from a transport budget and propagate deadline exceptions. Neither licenses swallowing this deadline or assuming a successful claim from incomplete observation.

## Solution

The allocator catches only the typed observation deadline after the original lease context exits. It retains the traceback and a pending receipt, validates the single successful configuration update and closed original lease, and consumes one exclusive reconciliation intent. A fresh lease permits one read of the same claim. The read must match the acknowledged incarnation, complete configuration, marker and inactive state. It cannot issue another configuration update. Mismatch, missing evidence, cancellation and another uncertain read remain failures.

The old evidence namespace and bytes are checked before and after the fresh operation. Recovered output explicitly records that the original read was not timely. It is a recovered diagnostic within the new attempt, not a retrospective change to Original77 or a terminal-infrastructure reclassification.

The user subsequently instructed: “Let’s relax some of the more aggressive timeouts in this last boundary (e.g. 10s -> 20s)”. The claim's inactive observation therefore uses twenty seconds. Reservation observation retains its ten-second default; task1200, overall5400 and lease limits remain unchanged. The new timeout argument rejects nonfinite, nonpositive and greater-than-twenty values.

The existing parked-claim reader recognizes the exact prior claim protocol and its older allocator separately from the new complete function/class closure. Historical claim parsing and capacity credit are unchanged.

## Verification and limits

The same production allocator/adapter/response-save control fails on the old code with ObservationDeadline and passes with one configuration update and a fresh read. Thirty-six owning controls cover changed identity, missing or altered evidence, failed lease closure, cancellation, duplicate reconciliation and timeout boundaries. Ten parked-reader controls cover the old protocol and changed helper rejection. Exact source and command receipts are retained with the integration manifest.

These controls establish the mechanism. They do not establish a passing unchanged browser task or a qualifying600 run. The benchmark outcome remains open until a new immutable source completes the normal campaign.

## Human feedback

Keep the task set, concurrency, protected resources, original failures and clocks. Apply the explicitly authorized timeout change only to the implicated future claim observation. Preserve a visible distinction between the original timeout and a later successful read.

## Reusable lesson

An accepted write and an incomplete observation are different facts. Preserve both, and reconcile current state through a bounded read with exact ownership instead of repeating the write or accepting late evidence as timely success.
