---
id: 2026-10-17-workspace-volume-read-crashed-after-create
date: 2026-10-17
title: Workspace volume verification dereferenced an unclassified missing response
surface: infra
component: cloudbench-disposable-controller
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: volume dereferences the native response without classifying missing or malformed data after a positive workspace allocation
symptoms:
  - AttributeError on native get in backup-off before Machine creation
  - workspace deletion remained pending after the canonical cleanup attempt
tags:
  - cloudbench
  - startup
  - native-observation
sources:
  - commit 1cec8c1cb20c85e66e10cd49446b44c5e85101f1
  - fleet run original600-1792274758905856974
repro: python3 scripts/tests/cloudbench-disposable-controller.test.py
status: open
---

## Problem

Original75 recovered 551 reservations and passed its final fresh capacity check. The gate recorded a positive workspace-volume create and wrote exact local ownership, then the first backup-configuration read returned None. The volume helper dereferenced that value and raised AttributeError before any Machine-create intent or supervisor was recorded. The source did not retain the GET HTTP status/body, so neither a404 nor a successful null body is established.

## Diagnosis

The saved packet SHA256 is1bd06946cc8bf3186fd9f13fe2e0797e5743f412550133f22c434b84c4bb9731. Positive allocation identifies vol_r68q592glezklyd4. Its ownership binds the create and intent bytes. The gate seals that ownership before backup-off; it records Machine-create intent only after backup verification. The exact known source and retained namespace put this failure before that boundary.

The canonical cleanup subsequently read a complete detached volume, wrote its exact delete intent, and issued one delete. Its following read was not yet terminal, so cleanup remained pending and the original caller stayed alive. That old cleanup outcome is preserved. No missing startup read proves absence or authorizes repeating creation/deletion.

The earliest owned defect is the unchecked native-response shape and lost HTTP classification. The underlying provider reason for returning a missing value remains unknown. The positive-create and later complete cleanup read do not establish permanent loss or host failure.

## Prior archive search

Searches for volume404/null and workspace missing/absent found the released-startup-workspace continuation case and the September10 Machine/volume migration case. These cover resource closure and changed associations, respectively. They do not classify the first post-allocation read. The earlier Original75 incomplete-Machine-list image check is a related missing-observation contract failure in a different reader.

## Solution

The two-file repair passed17 owning controls, including the same main-entry fixture failing at the original line99 before the fix and succeeding afterward. Preserve exact local ownership and protected-resource checks before native interpretation, classify a real NotFound separately from a malformed positive null body, retain raw HTTP evidence, and allow only bounded read observation within the existing action/request limits. Never replay create, backup PUT or delete. The current release was independently reconciled through one exact GET-only invocation of the unchanged old cleanup function. Both recorded responses were HTTP200 objects; the canonical release records pending_destroy, not absence. The original caller joined with exit1 and the monitor joined with exit0. No delete was replayed.

The fixed runtime records raw responses for actions with an explicit existing output directory. Initial admission has no directory argument and runs before the gate creates that directory, so its existing behavior is retained and covered by the actual-entry control. Startup re-observes only typed NotFound reads; action deadlines and cancellation propagate. The original180-second action and20-second request bounds remain unchanged. Post-update verification never repeats a backup update. These controls do not establish a passing live600-task run.

## Human feedback

The user requested simpler startup and an explanation of repeated full-parallelization failures. This failure happened before Machine creation or any of the600 tasks, so no task or parallel-execution outcome is inferred.

## Reusable lesson

A positive allocation followed by a missing read is an observation problem until classified. Preserve its cleanup obligation and distinguish typed absence, malformed success, and transient read failure before making lifecycle decisions.

## Closed unused admission reuse

The next normal attempt must use the repaired helper, rather than rerun the failed old helper under a new label. Its closed-admission reader validates the known original source, complete host namespace, positive allocation and cleanup bindings, actual caller closure and the two recorded GET200 release responses. It factors the existing pure reservation-history validation from the archive reader while retaining the ordinary full-controller archive requirements. No controller archive existed for this attempt and none is fabricated.

Eighteen unused-reservation controls and nine recovered-history controls pass, including the full unused-reader to recovery-history to next-admission integration. The original reader fails that same fixture at the missing verified-export boundary. Protected identities, a new Machine-create intent, and an incomplete current configuration are rejected. The full551 real reservation history remains for the normal read-only preparation on the owning executor; this local fixture does not claim that live result.
