---
id: 2026-10-29-it14-bu053-submission-time-narrowed-to-date
date: 2026-10-29
title: BU053 schema and verifier reduce requested submission time to a date
surface: agents
component: browser-semantic-completion-verifier
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Native generated schema describes requested submission time as date-only and the verifier accepts date-only values despite full timestamps in context
symptoms:
  - Native COMPLETED while C2 final-output criterion fails
  - Full UTC timestamps present in admitted verifier context
  - Final outputs retain only YYYY-MM-DD
tags:
  - r46
  - it14
  - schema-faithfulness
  - precision
sources:
  - commit 85d37fc8ab8e284459977debdef34348d825ef84
  - agent 3c1efab3-0454-4a6a-8e18-02197a124107
repro: none-recorded; original encoded request response and judge evidence only
status: open
---

## Problem

Source85d37fc8ab8e284459977debdef34348d825ef84, patchnone. Archive0979043a70cd52fe3256feeff8175e9f5f5740c6c722f3a90b890179c839bc5e, normalmanifestce08c364e487d120bedc94ca0fb7abbf0a3881c5a7eb2371406648aa4301a829, runaee2a138b27f605a54e87901ef65d185c2177540eec09d11757d6b6f42b44b92; all7members byte/SHAverified. NativeCOMPLETED145.5s is distinct from genuine taskFAILED2/3/infraFALSE. C1/C3passed; C2rejected date-only outputs when task requested submission times.

Actualschema request063d6de5c80668968f5e6aec1a8f73d1f0d6b7553e6f76315c21a3e39718b2e8 retains original goal. Actual Qwen responsec61e101426db43e99c5b3c823d1ff59f18134996ba46f269783cec96b7d428ea uses the NEW finite node wire correctly but defines v1_submission_time description as Submission date ... e.g.YYYY-MM-DD. Its reasoning also substitutes date for time. Canonical browser output_schema has the same text. Thus earliest recorded semantic narrowing is model-authored schema content, not a dropped node or unsupported nested type.

Actualbrowserverifier request7fcc6a1bcc71272968d7739fd3aa6e1f31475be88662015716edce7d7b983e87 contains original goal, narrowed schema, and actual fullUTC history: WebArena v1 Tue25Jul2023 22:59:32UTC appears3times. Date-only entries also appear in action evidence. Actualresponsead4a3994466ab5e5879092a9a7b8757790fe2625396b53715406f8e81c0a24b2 returns all10 date-only strings, task_completed=true/score1.0. Parent completion reuses childstructuredoutput; final42/44 preserves dates, with no observed transport alteration. Exact declared judgeC2 calls out missing times; C1/C3 do not negate that omission.

No missing-context explanation supported: fulltimestamp reaches nativeverifier. No recurrence of fixed finite-wire capability/JS-history/R35reload established. A task-specific timestamp regex, schema-description rewrite, or prompt nudge would change semantic policy without a general causal mechanism. No safe deterministic runtimecandidate justified; OPEN schema-faithfulness/semantic-verdict floor. All originalgrades retained. Existing-file decoding only, no API/model/browser/provider/DB/capture/test/source changes; tokensUNMETERED.


## Diagnosis

The original task asks for submission time of the first arXiv version. The
literal goal reaches schema generation. The new finite node representation
accepts the emitted field, including its model-authored date-only description;
no converter mutation is observed. The browser schema, actual verifier input,
verifier result and final completion all preserve that description/output.
The independent evaluator records C1=PASS, C2=FAIL, C3=PASS. Full timestamp
availability does not make the date-only final response satisfy the requested
precision. The native task_completed=true/score1 is not external PASS evidence.

## Solution

OPEN: safe general semantic-faithfulness capability is not established by this
single trace. Two archive searches after original evidence (schema/date/time;
submission/timestamp) were followed by full reading of the finite-native-wire
case and prior BU029 scope-narrowing case. The finite wire succeeds in this run;
its previous structural failure is not recurrent. BU029's narrower generated
schema is a conceptual relative, not proof of an identical mechanical cause.

No task-specific timestamp regex, forced answer, schema-description replacement,
prompt/model nudge, or criteria change is proposed. No deterministic runtime
repair with a same-boundary causal counterfactual was established. Original
source, grades and clocks are immutable. Assignment began 2026-10-29 02:34 UTC;
normal task failure timestamp 02:31:57.740913 remains distinct.

## Human feedback

The coordinator required original encoded native evidence before family
classification and prohibited assuming prior schema/JS/R35 recurrence. The
first-disposition handoff identifies semantic narrowing with retained data,
not transport loss. No runtime changes, model replay, external calls, fresh
capture, tests, provider actions or live-source edits were performed.

## Reusable lesson

A correctly transported schema can still reduce a requested time to a date.
Check literal task precision against generated descriptions and actual final
values before attributing missing detail to evidence transport or a known
structural schema limitation.
