---
id: 2026-10-29-it13-bu051-r1-failed-stack-cleanup-unsealed-runtime
date: 2026-10-29
title: BU051 r1 failed stack cleanup leaves runtime evidence unsealed
surface: infra
component: cloudbench-runtime-evidence
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Authenticated stack cleanup receipt records failed and cannot authorize a clean guest acknowledgement
symptoms:
  - Diagnostic runtime manifest exists with zero proof credit while normal manifest is absent
  - Original native task failed before campaign infrastructure classification
  - Exact Machine stopped with volume and ownership retained
tags:
  - r39
  - it13
  - runtime-evidence
  - cleanup
sources:
  - commit 765caac00ce085dd0359b8342161a8717be7446d
  - agent 49e8969d-bc7b-472b-97c3-d256c3fc1e9a
repro: none-recorded; original diagnostic and cleanup receipts only
status: open
---

## Problem

Assignment clock: 2026-10-29T00:26:25.220257+00:00. Source: 765caac00ce085dd0359b8342161a8717be7446d. Tokens UNMETERED. Offline reads only; no runtime mutation or recovery.

## Evidence custody
Diagnostic archive SHA256 f507adaa43cfc46ae9e87d1be24ab926e291b6b9fa9f4dc488b4bbe600a3e6e2. All eight floor file hashes/sizes and all seven diagnostic manifest members independently match. All seven separately supplied release-floor files match. Manifest explicitly diagnostic_only=true, proof_credit=0, stack_cleanup_state=failed. Normal runtime manifest absent; no normal export or task-credit claim.

## Diagnosis
1. Worker log 67349-67353: original root 49e8969d-bc7b-472b-97c3-d256c3fc1e9a fails at 2026-10-28T23:43:50.58Z with Native browser task did not complete successfully. Earlier child cleanup reports HTTP500/pause=true for session sess_b28038d95f524ec18f263ab4ce321ef6; prior CDP timeouts remain diagnostic context, not proven cause of stack sealing failure.
2. Driver line17122: benchmark finished rc=1 at23:44:41. Worker67372-67375 logs shutdown signal, 2100s grace, Worker shutdown complete and Worker stopped at23:44:43.175-188Z. These events prove logical worker shutdown logging, NOT supervisor/process exit. Metrics requests continue in that log through00:20:47.703933Z.
3. Authenticated cleanup.status records state=failed, token68253a245e8a4f4e8c6f8f2d5619f14c-0, stack_pid1594, nativeidentity linux:f16ab84a-b910-46d2-b77d-945cbfb1e957:14937. Services manifest says stopped at00:20:56.633874Z. Stack.log ends at Stopping all services. No exact supervisor exit status, join failure reason, or per-HTTP collector observations is captured.
4. Source run.sh2634-2692 writes failed on drain failure (including nonzero reaped supervisor), and only clean otherwise. run-process-cleanup.sh46-61 distinguishes process join from logical Worker stopped; wait nonzero also yields failure. cloudbench-run.sh249-272 refuses guest ACK unless exact stack identity+clean state. run-bench-cloud4919+ requires sealed manifest and terminal clean ACK, while its separate failed-evidence path preserves diagnostic failed state. This is consistent fail-closed behavior; no evidence supports accepting this diagnostic as normal proof.
5. Joblog466-470: later cleanup HTTP000, shutdown not delivered, exact machine natively stopped, normal manifest never collected. This is a later host cleanup/transport observation, not proof of the first stack failure's cause. Machine879640a0615ee8, volumevol_4y8gl2w3n666gnpr, ownership retained. Lifecycle failed/error125, audit hash empty; task_status INFRA_ERROR / terminal_task=false retained separately from original native FAILED.

## Solution
OPEN: exact stack-supervisor terminal/join result and first failed seal/ACK observation are unavailable in supplied diagnostics. A deterministic source defect cannot yet be demonstrated. No timeout increase, retry, process-exit inference, regrade or candidate patch. Needed next evidence is an ALREADY captured exact supervisor exit/join receipt or guest driver/collector terminal error (including request result/timestamp), if one exists in original owner custody. No new probe or recovery requested. Underlying browser failure and later release failure remain separate; no full physical closure inferred.

## Human feedback

Parent read the full intake and accepted the causal OPEN floor. Preserve separate
native FAILED, campaign INFRA_ERROR, terminal_task=false and release FAILED.
Do not infer supervisor process exit from logical worker shutdown events. Only
an existing local receipt lookup is authorized elsewhere; this case does not
wait for it or authorize capture, recovery, signals, retry or a runtime change.

## Reusable lesson

A stopped service manifest and worker shutdown message do not substitute for
an exact clean supervisor and stack receipt. Preserve diagnostic bytes without
promoting them to a normal sealed runtime export or completed resource release.
