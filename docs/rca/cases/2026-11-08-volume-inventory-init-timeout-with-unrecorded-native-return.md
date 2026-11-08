---
id: 2026-11-08-volume-inventory-init-timeout-with-unrecorded-native-return
date: 2026-11-08
title: Volume inventory initialization timed out with no recorded native return
surface: infra
component: campaign-shared-inventory
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: fly_with_timeout30 volumes list had no recorded completion while the preceding native machine read completed
symptoms:
  - FLY_COMPLETION_TIMEOUT
  - fly_return_status=unknown fifo_read_status=142
  - shared inventory snapshot did not initialize
tags:
  - cloudbench
  - inventory
  - timeout
sources:
  - PR #1708 focused37
  - commit ce016428eeb484b19b503a6f65884eb92f1e3fde
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py
status: open
---

## Problem

Focused37 failed before any of its nine jobs started. Original request token
72dc7409f3bf44b79b038639bed6fd24 and campaign deploy-d788145ff790487d1136027ef2ad7492221c2346c34add57c56b6cba51ea7adc
remain unchanged. Native adapter exit1/cleanup false and all9 UNVERIFIED remain.
The campaign records 23:34:54.528241 to23:35:53.849968, not an invented task window.
Original files were copied before analysis and hashed in original-manifest.json.

## Diagnosis

Path: native campaign starts API-only inventory publisher -> native machine
helper -> native volume-list CLI -> atomic index -> publisher owner -> relay/task
admission. Machine helper phase log completed in1.771s. The first failed phase is
volumes-list: the native30s fly_with_timeout reached FIFO read status142; its
native FLY return was unrecorded. Refresh history records total elapsed32s at
that failure. failure.raw.private is empty. The index/owner was never published.

One authorized exact read-only recheck with the same native30s wrapper and
flyctl volumes list -a navi-whisper-lux-bench --json succeeded in5.068s with120
records. That proves current availability only. No original request trace or
native return was captured to distinguish a transient provider response,
transport/client delay or native process stall. No outage or profile cause is
claimed. Gate: UNKNOWN for the original timeout. The wrapper bytes are identical
on ce016,74311 and6b505, but changed-file comparison is not causal attribution.
All five original copied publisher scripts match frozence016. Thirteen existing
EOF/timeout/child-reaping controls passed in12.35s; mocked deadline controls do
not substitute for reproducing the original provider event.

Archive searches: FLY_COMPLETION_TIMEOUT fifo_read_status; shared inventory
publisher snapshot FIFO read timeout. The October18 completion/orphan case is a
relative; no observed original return or orphan establishes its recurrence here.

## Solution

No timeout/runtime fix is justified. No cap, deadline, retry, profile, provider
resource, source ledger, or task definition was changed.

A separate proven native cleanup capability gap prevented ordinary launch-only
retirement: existing campaign-unlaunched-v1 demands a missing-flyctl exception;
relay layouts demand relay evidence which never existed. The typed
campaign-inventory-init-failure-v1 route handles this exact audited source
boundary. It binds original request/receipt/adapter and all publisher source
bytes; checks native timeout diagnostics without converting unknown return to
zero; requires zero admitted jobs/empty runs/no publisher owner/stop; checks
native supervisor quiescence, absent exact processes and no log holders; and
verifies native campaign final-publication acknowledgement. It returns no
participants or credit, preserving original outcomes.

The actual captured proof is rejected by original native validate as unsupported
layout and accepted by candidate validate with all9 UNVERIFIED and credit false.
This read-only validation did not reconcile or alter the canonical ledger.
Registered tests preserve that positive counterexample and reject participants,
owners, live writers/processes, unknown/orphaned supervisors, changed sources and
forged outcomes. Two legacy unlaunched tests remain passing. Four focused native
tests pass on the final candidate, including actual c.reconcile on a private
fixture with all original attempts unchanged; the unchanged final positive test failed on
the original validator. Exact commands, exits, clocks and hashes are in result.json.

Known intermediate private failures (source binding closure during construction)
remain visible in logs/tool evidence. No original failure is rewritten. The case
stays OPEN for timeout causality and parent integration/full original gate.
Golden reference: not applicable (native evidence validation; no prompt change).

## Human feedback

The user forbade replacement scope and budget/cap/retry changes. The RCA child
was restricted from canonical/provider writes. The deploy owner requested a
strict typed launch-only route after confirming existing routes do not fit; no
relay or missing-tool evidence may be invented. The deploy owner retains integration, physical reconciliation and every original gate; this record grants no acceptance credit.

## Reusable lesson

Preserve an unknown native return as unknown, and retire an unlaunched campaign only from source-bound zero-admission and complete process/publication evidence.


## Independent R1 correction

Review of patch043fc demonstrated that a real Git commit could carry an altered
executed run-bench wrapper and still satisfy the six downstream source checks.
The wrapper was never executed in the counterexample. Its changed bytes were
accepted by native validation, so this was a real source-closure gap.

The correction binds run-bench SHA256
d6a63399d3ae00ae83d469f06ad44870a57ad13a85c99703366137012fc1420e
and the audited native pre-inventory callees listed in r1-callee-audit.json. The
exact original command traverses catalog/timeout/ordinary-width code, then
campaign preflight and owned publication before the failed inventory startup.
The additions bind executable repository modules on that path; task data,
limits, deadlines and launch configuration are unchanged.

The new registered real-Git regression failed on the reviewed code because the
changed wrapper was accepted, then passed unchanged after the correction. The
original four native tests and new regression all pass (five tests). Replaying
the independent counterexamples now rejects the changed wrapper; baseline
retirement still succeeds. Actual original proof validation remains exit0,
with all9 UNVERIFIED and no participants or credit. Diagnostic-epoch ordering
remains the explicit nonblocking review limitation; no new failure attribution
is claimed. Original timeout Gate UNKNOWN remains unchanged.

Final private patch SHA256: b553ac51013075313711e8725817613252d4929120b22844740d8bad106ad6d5. No canonical integration, provider operation,
new automated review request or live reconciliation occurred in this follow-up.

Independent local review found a missing entrypoint source binding. The final correction binds the original wrapper and audited pre-inventory callees; its unchanged real-Git counterexample now rejects an altered entrypoint. All five focused controls and the actual original read-only proof replay pass. The independent recheck is P2_CLEAR for patch b553ac51013075313711e8725817613252d4929120b22844740d8bad106ad6d5. No CodeRabbit review was consumed by these local checks. The original timeout remains UNKNOWN and all nine original task outcomes remain UNVERIFIED.
