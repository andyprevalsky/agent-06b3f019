---
id: 2026-10-29-it21-bu088-research-incomplete-at-step-budget
date: 2026-10-29
title: BU088 research remains incomplete when the browser step budget pauses execution
surface: agents
component: browser-research-and-benchmark-terminal-evidence
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Last captured actor selects another search without a verified answer; budget pause and low root progress are observed but no causal runtime defect is established
symptoms:
  - "Browser step budget reached: 100/100 — pausing for polar judge"
  - "Low progress score: 0.00"
  - "User paused the browser agent"
tags:
  - r82
  - it21
  - polar-bu-088
sources:
  - commit 47a0e9d6c9a89e2d97933935509343372d565250
  - agent d47f4641-96e4-41fa-a175-ada09d75fa6d
  - plan: normal archive a2f4c1ba1a556d7d9cccb83a8e32b092161b054547ab8cae1a6fa040245cd56b
repro: none-recorded; original request and outcome custody only
status: open
---

## Problem

Original It21 BU088r1/job r001-j0008, fleet20261029-204111-3891934, ran
source47a0e9d6c9a89e2d97933935509343372d565250 with no patch. The task asks
for the type of pill taken by the younger of two deceased individuals, using
specified date, age, distance and common-coroner clues. Native status PAUSED
and duration2222.1seconds are distinct from canonical FAILED/infraFALSE,
joined2026-10-29T21:30:34.523278Z. No approval was triggered or resolved.

All seven normal member sizes and SHA256 hashes independently verify against
manifestc245afc8e101a0b9b877a9182daa901c48884c2fbdfb191414b43e3740461c3b.
The normal run SHA256 is
fc1e990b19f307f45e1bea9c35bc07c766f726e4b094355c0bbbb1ebb282d607;
worker6e8724072e1583aff6726649479b835e4871cd0e9b42482f44f5dfd896b4af96.
Supplemental driver/lifecycle files are separately bound by the supplied
receipt, not claimed to be members of the normal runtime manifest.

## Diagnosis

The observed path is original task and schema -> repeated native research
navigation/evaluation -> runner step-budget pause -> low root progress failure.
The schema asks for required nonnullable string pill_type and report mode.
There is no recorded completed answer or completion-verifier exchange.

The actual last completed actor request browser_use_step_99/request74d98fe2d508
is captured at worker line25013. Its decoded bytes match
3bc3508d729ed39d745837fe5a728eb156fc62f71d5ff1d3ff9c332b57544317.
All original task wording is retained in this input. Its output chooses another
Google search with the coroner/age/pill clues, not attempt_completion.
The prior step98/request462e88c0347c has request hash
6eb5019c07dde96e82e8eaff740e581871c7e8a9cbdebe18811251040bcfa63f and
reads the current search page using JavaScript. Earlier Google/Bing/native page
results and unsuccessful candidate searches remain in the original history.
No controlled replay establishes a model-capability or transport cause.

The supplemental driver explicitly reports at line17524:
“Browser step budget reached: 100/100 — pausing for polar judge”. Exact source
run_benchmark.py5088-5113 counts browser steps and calls pause_agent for this
condition. Backend POST/pause starts21:26:06.142Z and returns200 at
21:26:06.465Z; workflow cancellation is recorded21:26:06.637041Z.
Actor step100 starts21:26:09.026931Z, but no completed step100 dump is present;
activity cancellation logs21:26:09.635547Z. Workflow signal and local activity
cancellation delivery are not interchangeable timestamps. This is not evidence
that a human manually paused the run, nor proof that a missing local guard
caused research noncompletion.

The driver finally reports Low progress score0.00. The native root progress
field is0. evaluate_task permits the intentional Polar budget PAUSED status
but then rejects low progress; run_single_task invokes declared evaluators
with static_only when that prior result failed. Thus no declared semantic
rubric result is present, and none is invented here. Zero aggregate model
calls/tokens/cost does not prove zero execution: worker logs contain111
rose.complete.start events and110 captured request dumps, including real
browser actor calls and ten observation actions that did not consume budget.
Those counts are log coverage, not independent billing totals.

A separate terminal browser cleanup returnedHTTP500, visible in messages236,
239 and240. Later normal cleanup records DELETE204 for the same Tilion session,
no cleanup errors, a sealed tree and root soft-deletion. The retained root row
still exists; this is not physical row absence or a claim of global resource
absence. The transient error does not establish a terminal infrastructure
failure or explain the preceding incomplete research.

## Solution

OPEN, no runtime candidate. No cap increase, task-specific query/prompt,
forced pill answer, criterion change, model replay or new provider call.
The captured requests establish ongoing research and its stop boundary, not
a reproducible mechanical defect or a validated answer before the pause.
A causal repair would require an actual owned faulty transition or a controlled
unchanged input comparison; neither was established from this bounded intake.
The active run and original result remain unchanged.

## Verification

Read the actual normal actor/schema/worker/backend and supplemental driver
bytes, checked all seven normal hashes, and decoded the final two captured
actor requests with their payload checksums. No runtime test or live replay was
claimed. Archive searches used “Low progress score” and “step budget paused
research”. Read the Solution and Human feedback of the BU067 source-price pause
case and the BU051 historical-diagram case. They are relatives in budget/grade
reporting, not proof of shared missing visual or source-specific evidence here.
A new bounded case avoids merging distinct research questions or causes.

## Human feedback

The coordinator required original native-versus-benchmark separation, urgent
reporting of positive infrastructure evidence without independent stop authority,
and no cause inference from PAUSED alone. Preserve active source and original
outcomes; no old-family assumption, task-answer patch or paid rerun. Tokens
UNMETERED. The recovered cleanup500 and later204 were reported separately.

## Reusable lesson

Trace the actual pause initiator and last captured actor decision before
classifying a low-progress result or treating missing aggregate usage as no work.

## R101 observed budget-stop variant: original It25 BU088r1

Original r001-j0008/root35cc19f5-0d07-4ec3-bed2-427e4fa451b9 executes
3dc00896d3b8dcc0b3666c9c8493507ee96c7809/patchnone. Archive
8d8b68b0146a03a478e8090e15ee53cbfcb4fc96e5f8c1f74b3db04a10a4a167 and all
seven original members match manifest
920fea13653266916e8d58b9fe15aa96b4ce07e86e288896515d7debf220f636.
Run SHA f6d4d9791933892eccc88dcacdea65547565d8358a0799fa015852b8b5b9cd83
records nativePAUSED2059.4s/progress0, canonicalFAILED and originalinfraFALSE.
There is no declared semantic judge result. This is not the It22 CDP socket
failure simply because the task ID is shared.

The original supplemental driver line16297 explicitly says Browser step budget
reached100/100, pausing for Polar judge. Normal worker25693 records completed
budget step99/evaluate at03:27:46.619405Z. Its raw output dump3a81b7509d4b
at25677 has decoded SHA
d1a74f4f5fa328799f2327cf931e4e56617cad6365ae0c6e9c7e10d8f50af3ca
and selects extraction of the current search page. The preceding goto searched
Oxfordshire, tablet, died and1993. No completed answer or attempt_completion
is present. A BBC article about a green AMT pill occurs earlier in the actual
history, but the record does not bind the two deaths, dates, ages, distance
and coroner into an accepted solution.

There are103 distinct completed action receipt indices:53goto,46evaluate and
4read_browser_state, plus4 explicit observation-budget refunds. These receipt
counts are not a replacement for the driver's100-step counter; a following
model request is in flight when the pause arrives. Worker25708 starts that
request at03:27:50.498268Z, before workflowPAUSE at03:27:51.057595Z.
Cancellation is requested immediately and the activity records paused
cancellation at03:27:53.030747Z. No completed next response is retained.
This ordering does not prove a new model call after local cancellation or a
missing pause guard. Later UI text saying paused by user does not override
the original driver budget initiator.

Archive searches covered BU088 budget and100-step incomplete research. The
prior case's Solution/Human feedback and the BU083 source-identification case
were read after this trace. This occurrence matches the observed bounded
research-stop pattern, while retaining its distinct inputs and cancellation
ordering; no model-intelligence cause is established without a controlled
comparison. No cap, prompt, answer, grade or runtime repair was made.

Final normal cleanup records exact Tilion session
sess_0351eca3b4af436eb0e171f29e0ccf46 DELETE204, root deleted and tree sealed.
Incidental passkey/recording errors do not displace that final closure evidence.
No positive operational transport failure or new native/model/DB call was
introduced. Original outcomes and the earlier case bytes remain preserved;
selected driver/worker hashes are in .context/r101/proof.json. Outcome remains
OPEN, with no separate duplicate fix or test lane.


## R101 routing repair — reviewed future source, original outcome remains open

A bounded follow-up on 2026-10-30 isolated a separate deterministic grading
admission defect. In original It25 BU088r1, required nonnullable `pill_type`
correctly described the requested answer. Root progress remained its startup
zero; the captured worker contained no completion-verifier invocation or
returned validation score before the recorded 100-step pause. This does not
establish an answered task or a model-quality cause.

The existing `evaluate_task` budget-pause exception explicitly admits a Polar
trajectory for its declared judge, but the later `progress < 0.5` check returned
false first. `run_single_task` consequently skipped the declared Polar judge.
The unchanged full-runner reproduction with all 229 original messages failed
with zero judge calls and `Low progress score: 0.00`; the candidate reached one
mocked Polar judge with those exact messages. Its supplied score remained zero
and the resulting task remained FAIL. No actual judge, actor or provider call
was made, and the original recorded outcome was not recomputed.

The repair bypasses only that lifecycle-progress precondition for an explicitly
budget-paused Polar task with an enforced declared Polar evaluator. It writes
neither status nor progress. Native FAILED/CANCELLED, ordinary pause, non-Polar,
unenforced evaluation, and completed-low-progress cases retain their gates.
Required-tool, context and static failures remain effective. No rubric, prompt,
criterion, step/time budget, provider setting or evidence transformation changes.

Exact reviewed two-file patch SHA256:
`50621902f983af655494b350f80c311fc3c36a6bcb784dd8cdd947b1a725496c`.
Base `c660f41852d46cd020aedd0be5b8214657aa5f5f`; runtime preimage equals
executed `3dc00896d3b8dcc0b3666c9c8493507ee96c7809`.
Independent reviewer B returned GROUNDED; the parent independently verified
RED/GREEN and authorized only these bytes on this isolated future branch.
The permanent regression in `cloud_batch_cleanup_test.py` runs ten controls
through the actual task runner and declared-evaluator dispatcher. Existing
`benchmark.blackbox.py` automatically registers this test module's cases.
Full original-message reproduction also passes its four routing controls.

Opened primary comparisons: Hermes `agent/turn_failure_copy.py:146` and
`tui_gateway/prompt_turn.py:49` distinguish a nonfailed iteration-budget handoff
eligible for goal judging from failure/interruption; Codex
`codex-rs/core/src/realtime_history.rs:160` preserves distinct completion/abort
lifecycle facts; OpenClaw
`src/agents/embedded-agent-subscribe.handlers.lifecycle.ts:95` distinguishes
terminal delivery from incomplete/error output. Only Hermes directly provides
a judge-admission analogue; its required summary is not imported into Rose's
existing full-trajectory contract. The other references do not independently
justify grading an aborted or failed task.

The original native PAUSED/benchmark FAIL/infraFALSE and cleanup records remain
immutable. The research result and unchanged-task success are still OPEN.
Future eligible runs may make their normal declared judge calls instead of
being rejected before judging; no deployment, live source update, original
regrade or new benchmark was performed by this repair lane.


## It25 BU088r2 — final verifier started, then budget pause cancelled it

Original r002-j0018/root `a3def611-fc90-4b17-b88e-c2902e049a64`, fleet
`20261030-035513-1929853`, executes source
`3dc00896d3b8dcc0b3666c9c8493507ee96c7809` without a patch. All seven normal
member sizes and hashes independently verify. Archive SHA256
`83d3f4152c11accf9227bffb77272b4fba57a96166e2089b55da31ae29427132`;
manifest `0862ca1d27e465b36835de1772b4dd91fb97937e2ee3cf89a87a7c50aa125c72`;
run `25f0e54d4ff92256bcee48a00426dd37f2312d6f605fa26004d82796cddfd9e0`;
worker `577c6d4cc099d0df8a33e233a254255369c1c942263fc79eb303b73319fb4d3c`.
Native PAUSED/2801.6 seconds/progress0 differs from canonical FAIL,
`Low progress score: 0.00`, producer infraFALSE and cleanup_failureNone.

The generated and persisted schema correctly requires nonnullable string
`younger_victim_pill_type`, described as the pill the younger victim took.
Original schema output hash
`e1c6498fec3a6d126a4c5226968e54520c596fe79f8d32e660ed29908ee470b8`.
Unlike r1, r2 did start completion verification: worker43834 records the
100-iteration limit at04:47:47.557372Z, and worker43854/43855 records
`verifier_browser_max_steps` request `05ad5e7a37d2` at04:47:48.534647Z/
04:47:48.539824Z. Its complete429555-byte decoded input SHA256 is
`1c81ca0916bcc4492ecb071783d73f3c4999994c89a9420aaa6e4166e07bdc7a`.
That request includes the original goal, the correct required field, final
browser state, an actual screenshot and retained tool-result evidence.
It is not evidence of a returned score or a completed answer.

Supplemental driver21749 records `Browser step budget reached: 100/100`.
Workflow PAUSE arrives04:47:51.147554Z (worker43858); check_progress ends with
an error and the browser activity records cancellation04:48:00.320516Z
(worker43864/43865). No completed verifier response or structured output is
present. Root progress was initialized to0 at04:01:10.367382Z (worker50);
there is no captured later root score update or declared evaluator result.
Thus this zero is not a returned verifier judgment. The separate R101 routing
repair applies to this budget-PAUSED result, without retroactively grading it.

The cancellation ownership is explicit: benchmark `_poll_agent` sends ordinary
pause at the budget; workflow `pause` sets is_paused; the browser manager calls
activity_handle.cancel; the nested verifier await propagates cancellation.
The existing pause/kill contract must not be weakened to preserve a score.
No task/generation-bound final-verifier handoff is supplied to the benchmark
poller. Arbitrary delay, shielding all final verification, or ignoring pause
would not be a safe narrow repair. No second runtime fix or new test lane was
introduced; a distinct safe handoff would require its own explicit contract.

An earlier socket closure at04:27:42.298849Z recovered at04:27:48.857380Z;
subsequent actor work and final verification were recorded. This is not an
unrecovered terminal transport failure. Tilion session
`sess_0351ec9c5a06407a84a73982f680125d` has recorded DELETE204, root deletion
and sealed tree. Original PAUSED/FAIL/infraFALSE and cleanup records remain
unchanged. Research sufficiency, returned native verification and the original
unchanged-task outcome remain OPEN; no model, browser, DB or provider call,
new benchmark, outcome claim or live-source change was made.

### R106 — bounded finalizer handoff repair (future source)

The original It25 BU088r2 evidence above remains unchanged: source
`3dc00896d3b8dcc0b3666c9c8493507ee96c7809`, native PAUSED, progress 0,
benchmark FAIL, and producer infra FALSE. The final verifier started at
04:47:48.539824Z; the budget pause arrived at 04:47:51.147554Z and activity
cancellation followed at 04:48:00.320516Z. No verifier result was persisted.
This differs from r1's absence of a completion invocation.

The reviewed future-source repair preserves an already-active finalizer only
when an acknowledged ticket binds the exact task, current Temporal run,
first execution run, activity, attempt, nonce, exhausted step limit, schema
revision, and original activity deadline. It adds no browser action, model
call, retry allowance, or time budget. Missing or early tickets, resumed
activities, multiple active tasks, and invalid identity/deadline fall back to
the existing pause. Ordinary pause, kill, sealing, and schema changes retain
cancellation authority. An accepted stop prevents new root/child dispatch;
finalization retains credential and cleanup duties before parking the root.
It does not fabricate verification, progress, success, or cleanup evidence.

Exact reviewed patch SHA-256:
`d95a8bde66e03099baa65429a9ead5fa35fe713f004356b1f73504a245c4e08f`.
Independent reviewer B returned GROUNDED; parent independently verified the
13 preimages/output hashes and the causal RED/GREEN plus five native-activity
controls. The same owning baseline canceled the blocked verifier; the
candidate allowed its result before pause. Mocked external services make this
a routing/lifecycle proof, not a replay or successful completion of the
original task. The existing R101 declared-judge routing repair is preserved.

Post-application checks on the exact reviewed bytes passed: registered
finalizer handoff (five native activity/manager scenarios), ticket guards
(24 rejection/acceptance controls), accepted/refused poller paths, and ten
backend ownership/generation/refusal controls. Pinned Python compilation,
archive validation, and whitespace checks are recorded in the handoff.
The prior targeted TypeScript baseline and candidate had the same five
unrelated DOM-global diagnostics; full clean TypeScript and Ruff are not
claimed. Original task success and any actual unchanged-judge outcome remain
OPEN. This change is qualified only for future integration; the live It26
source remains frozen separately.
