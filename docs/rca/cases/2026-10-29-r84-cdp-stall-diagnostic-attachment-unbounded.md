---
id: 2026-10-29-r84-cdp-stall-diagnostic-attachment-unbounded
date: 2026-10-29
title: R84 CDP stall diagnosis could hang while attaching its probe session
surface: agents
component: browser-cdp-stall-classifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: classify_evaluate_cdp_stall awaited CDP session attachment outside the advertised per-probe deadline after the action supervisor had timed out
symptoms:
  - "Browser action blocked at supervisor cap"
  - "oldest Target.attachToTarget"
  - "tree stalled"
tags:
  - r84
  - it21
  - polar-bu-084
  - cdp
sources:
  - commit 47a0e9d6c9a89e2d97933935509343372d565250
  - agent c298495c-b033-4da2-93dc-0e2b1439ec65
  - plan: original archive d42ea5920a6b51081dc631a215af8063e1c485500044cd8cbf9bc6dcb193f8df
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_cdp_stall_probe_bounds_session_attachment
status: mitigated
---

## Problem

It21 BU084r2/job r002-j0014 researched a virtual conference using a former
European foreign minister's biographical clues. Source47a0/patchnone recorded
native PAUSED2406.2seconds, root progress0 and canonical FAILED/infraFALSE.
The driver reported518seconds of newest-active silence against510seconds.
Those original classifications and the failed task remain unchanged.

All seven normal members independently match manifest
4f706135bc617bbc4619e578030eb6ffccb0d222db913116c4543a82cc897140.
The original archive SHA256 is
d42ea5920a6b51081dc631a215af8063e1c485500044cd8cbf9bc6dcb193f8df.

## Diagnosis

The last captured actor request, browser_use_step_23 at worker35823, has decoded
payload SHA2a5e48f8495a9a7f071eff9cdda2c846d9bdb161522254e7185999d0ee6775fc.
It calls open_new_tab for a Brave search. Worker35912 at21:21:21.152356Z reports
browser-level Target.createTarget pending and no upstream reply for687.6s;
Input.dispatchMouseEvent and Runtime.evaluate also time out while worker
metrics and loop remain responsive. This is positive CDP unresponsiveness
evidence, not proof of its upstream vendor cause.

Worker36117 at21:25:21.006076Z records the330s action supervisor cap. Instead
of reaching recovery, a new Target.attachToTarget is pending at36140,
21:25:51.212991Z. The workflow receives pause at36281,21:28:33.350119Z and
activity cancellation at36286,21:28:39.445005Z. Exact-source handler invokes
classify_evaluate_cdp_stall with2s probes after the action cap. Both renderer
and browser probes awaited session attachment before entering their send-only
timeout. A dead transport could therefore trap the diagnostic itself.

A permanent offline test stalls that exact attachment API. On unchanged
source it exceeds the test's0.3s external bound, with the stack in
context.new_cdp_session. On the candidate it returns bounded attachment error.
This proves the owned diagnostic deadline defect; it does not prove that a
subsequent recovery fixes the original provider connection or task answer.

## Solution

Each probe now gives attachment plus command one shared existing timeout.
Failure before obtaining a session is error, not frozen: an unperformed
renderer probe cannot authorize renderer hard recovery. Actual command timeout
retains the existing frozen classification. Cancellation propagates; only an
acquired session is detached, using the unchanged0.5s cleanup bound. The two
sequential probes each retain their existing2s budget, not one total2s budget.
No action cap, retry count, task prompt, evaluator, provider selection or
operational authority changes. Remote effects of an already dispatched attach
are not claimed to be retracted by Python cancellation.

Fresh independent reviewer C found exact patch
058a357f19304ea898f6dba11bec7f485c900c4a037d28ea946d83e125c89efe
GROUNDED, including baseline failure, five candidate controls and an extra
combined-delay check. Applied files match the approved hashes on isolated
future parentd188d4e511f88d90e1f32b9dcb30ad2e611a5769, whose preimages match47a0.
Existing R81/R82/R83 records are preserved.

## Verification

The actual registered suite selects three new classifier controls and existing
nested-timeout ownership/all-action classification checks: five PASS before
and after application. Cases cover either/both attachment stalls, actual send
timeouts, healthy probes, foreign errors, cancellation before/after acquisition
and exact-session detach. Python compile, archive validation and diff checks
pass. No browser/provider/model/API/DB calls or live replay were performed.

Personally opened primary analogs: Codex core/client.rs1298-1315 bounds the
whole WebSocket connection; Hermes agent/lsp/client.py459-485 bounds the whole
request and removes pending state; Claude Code utils/apiPreconnect.ts63-73
bounds connection-opening fetch. These support bounded setup. Their retries
or fire-and-forget error swallowing are not imported. Unlike a generic error
fallback, this change retains explicit diagnostic uncertainty and cancellation.

## Human feedback

The coordinator separated original producerinfraFALSE from operational
infrastructure evidence and independently authorized its one owner stop after
reviewing the recorded CDP silence. That operational decision is not a regrade.
The source repair stayed isolated until exact independent approval; active
owner source was not changed. Cleanup R85 is separate and unresolved here.
No taskPASS, vendor fix, full release or future successful recovery is claimed.

## Reusable lesson

Include diagnostic session setup in the probe's deadline and do not infer a
renderer failure from a probe that never attached.
