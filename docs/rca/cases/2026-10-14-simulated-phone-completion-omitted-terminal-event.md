---
id: 2026-10-14-simulated-phone-completion-omitted-terminal-event
date: 2026-10-14
title: Simulated phone completion omitted the terminal event consumed by DB polling
surface: harness
component: call-phone-number-manager
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: CallPhoneNumberManager.execute_tool returns simulated completion without a terminal TOOL post
symptoms:
  - Persist exactly one completion for the DB-polling caller
  - Nineteen calls to one office voicemail while caller inputs omit completed phone results
tags:
  - world-model
  - phone
  - tool-result
  - db-polling
sources:
  - PR #1453
  - agent bb938dbe-1cc2-437c-80e7-faf31f300ce2
  - commit 180358508093e2ce983f986333a10b42def24a41
repro: agents/tests/blackbox/call_phone_number.blackbox.py
status: mitigated
---

## Problem

The Run17 fundraiser committed nineteen phone calls to one office voicemail.
Its native observations contained the completed call, lack of a human response,
and instruction not to redial. All nineteen WHM requests retained the original
root goal; all eighteen later requests retained the preceding phone observation
and correlated call ID. The caller's nineteen corresponding execute-loop inputs
contained approval notifications but omitted completed phone TOOL bodies.
This was not evidence that the WHM dropped the goal or failed to see the results.

## Diagnosis

The real activity persists its completed result, but simulation bypasses that
real executor and returns the selected observation through the adapter. The
manager posted IN_PROGRESS and usage, then returned without a terminal post.
DB-polling agent loops rely on persisted results and do not append the returned
message locally. The simulated producer therefore omitted the completion
contract consumed by the existing loop.

The owning reproduction executes the actual manager, activity, simulation
adapter, event handler, and post-message argument path with a local recorded
client. The exact original selected voicemail body failed the completion-count
assertion before and passed afterward. A sanitized permanent regression uses
the same terminal-body/call-ID/error assertions: original manager FAIL, repaired
manager PASS. Independent runs measured 0.277 seconds and 0.346 seconds. The
entire wholly mocked registered phone domain passed 28 cases in 0.363 seconds.

Archive searches included simulated phone completion missing FINISHED and phone
result approval context repeated voicemail. The omitted simulated code-chip
lifecycle case is related, but this phone manager is a distinct producer.
The existing web-fetch manager posts terminal events through the same helper;
the reference tool-execution implementation preserves correlated result IDs.

## Solution

Only results marked world_model_simulated receive the missing terminal post.
The manager forwards the existing selected message verbatim with its original
agent/tool-call identity and ERROR or FINISHED status. Real and shadow activities
retain their original completion owner. Approval requirements, activity retry
policies, the adapter, WHM context acquisition, prompts, schemas, retrieval,
packing, sampling and failed-example filtering are unchanged. The permanent
test contains no original customer record, phone number or prompt.

One bounded event is added per successful simulated manager invocation; there
is no shared state, extra model call, polling loop, or tree-sized work. Existing
call-ID deduplication is retained. Exactly-once behavior across ambiguous DB
writes or repeated manager invocations is not proved by these controls.

This is a source-level delivery mitigation, not a verified fundraising fix.
No paid post-fix benchmark was run; prevention of the nineteen-call loop and
downstream fundraising progress remain unproved. The original FAILED verdict,
3,780.2-second duration and later join-verified retirement remain preserved.
No merge or deployment was performed.

## Human feedback

The user automatically approved infrastructure changes and reserved approval
for WHM context or logic acquiring runtime context. Independent scope review
classified this existing-result transport repair within infrastructure:
WHM context acquisition and the selected observation are unchanged. An earlier
private packet inferred that all planner feedback changes required approval;
that broader interpretation was not the user's stated rule and was superseded
by the exact source/consumer review. The user requested source preservation,
accurate trajectory scorecards and per-cluster RCA before another trial.

## Reusable lesson

Persist simulated tool completions through the same correlated terminal-event contract that DB-polling callers consume.
