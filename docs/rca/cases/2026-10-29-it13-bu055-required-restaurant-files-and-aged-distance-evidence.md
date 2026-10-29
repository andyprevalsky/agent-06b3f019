---
id: 2026-10-29-it13-bu055-required-restaurant-files-and-aged-distance-evidence
date: 2026-10-29
title: It13 BU055 rejects missing restaurant files then expires while chasing downloads
surface: agents
component: browser-schema-verifier-and-evidence-selection
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: generated required restaurant file-pointer arrays and bounded verifier history omit independently needed facts; no single causal task repair established
symptoms:
  - activity StartToClose timeout
  - The restaurants field requires remote-session file pointers
  - List should have at least 3 items after validation
  - Durable copy of Tilion download failed; kept in worker memory
tags:
  - polar
  - it13
  - r37
  - schema
  - evidence
sources:
  - commit 765caac00ce085dd0359b8342161a8717be7446d
  - agent 6a9bc540-586a-425f-acf0-45fd1a0320c0
  - fleet run 20261028-230247-3988103
  - plan: archive 6397c58ab2cf787786c0871df41d248830e7ebdb9f5bfb57da0f33891b1bb3f9
  - plan: normal manifest 2bc5f6af2da43b018531c951e701d8fe0645c1c38e033cf59bfa717d45e87f31
repro: none-recorded
status: open
---

## Problem

Original BU055 r1 asks for Tesla Superchargers in Evansville and Bloomington,
exact addresses and three restaurants within one mile driving distance of each,
including names, addresses and Google Maps pages. It ends nativeFAILED and
taskFAILED after3030.0seconds, infraFALSE. The intake started
2026-10-29T00:07:17.609851Z. No original grade, deadline or source changed.
All seven normal members and separately labelled supplements pass their receipt
hashes. Run SHA256 is
4df0130bf976bebf0bee3cb3ce18f7e35f7c1388ef275ab0aae047a99d6d8315;
full worker log SHA256 is
392084293739f20b064f409889c920165b91482a07ce771f49209a2e44f0c06a.
Embedded run worker logs are incomplete relative to that full log; the full
normal worker file was read for late verifier/download/terminal events.

## Diagnosis

The original generator requestc7b36b469e65 SHA256
8c72e0f0ddf6258b15cfe17875f54bd7169a332892948e59c03e92ad7e233eae
and response SHA256
bae48d223ddcc605a83f77033f6da38df90d8e300490fcadde0e620fddd8a02f
show the model asking for restaurant names, addresses and distances in reasoning,
while emitting required restaurants:list[file_pointer], minItems=maxItems=3,
nested under each supercharger. Unlike R34's optional field, missing files here
cannot satisfy the actual emitted schema. This is admitted public syntax, not
R24's internal/public type-literal failure.

Before completion, the original trajectory includes driving directions:
steps19,21,23 show Evansville0.5/0.4/0.7mile trips; steps27,29,31 show western
Bloomington0.4/0.7/0.9mile trips; later steps35/37 provide eastern trips. These
are original text observations, not independent proof of all requested coverage.
The actor's23:48:16 narrative claims three chargers and nine nearby restaurants.

At23:48:19.288043Z the actual final verifier request80a5e7b74e4e SHA256
4e135ad23d8f9887a1f889e1b93973bda5fb196199a46dee8589de84b6ff136e
contains the schema, current page evidence and newer evaluate results. The
response SHA256
6b5176b1a36e0ab23c3229a32464c6b99a58974bdc68aba7f48dc2d97bcd55e6
returns task_completed=false, score0.5. It reports missing driving-distance and
charger-completeness evidence as well as no session files. The original output
fails minItems validation, so completion is rejected. This rejection is not
solely a file-field issue: it contains independent evidence requirements.

The exact765 builder selects the last30 actions for evaluate receipts. At the
final attempt, actions44..73 remain; older directions and western charger
address have aged out. Independently retained read_browser_state snapshots
are also admitted. The final encoded context has evaluate steps48,51,54,57,60,
63,66,69,72; it does not contain the older0.4/0.7mile directions. The private
read-only inspect_original.py replayed the actual
build_verifier_context_messages against captured raw context and matched every
message exactly after excluding the separately inserted schema system message.
This verifies conversion custody, not a repair or complete actor-request replay.
The total tool-result use is35919/160000chars with one per-tool truncation;
this is not an aggregate160k starvation claim. Missing older evaluates occur
upstream in the intentional action window.

At23:49:51 the actor says it needs a downloaded file for each restaurant and
that older evidence is no longer visible. It navigates to a synthetic httpbin
attachment URL. Native downloadWillBegin occurs; the worker materializes664bytes
but durable upload returns400. A second such attempt at23:57:14 materializes
670bytes and also returns400. These receipts prove attempted downloads and
worker-memory materialization, not valid restaurant evidence or durable delivery.
The storage error body is not captured in the inspected event; no storage-cause
or filename fix is established. No file contents were invented or inspected as
an image. The actor treats ERR_ABORTED as possible download completion; the
separate native download events support that a download started, not task success.

The activity reaches StartToClose timeout at23:58:21.823Z, then cancellation and
cleanup. The later 'Agent paused by user' text is retained as emitted, not proof
of a new human action. No final passing verifier or declared-judge verdict is
present. Initial schema choice, older-evidence selection and unsuccessful
artifact pursuit are distinct observations; none alone proves a repair would
resolve the original task.

Archive searches used `restaurants required file pointers` and
`within one mile driving timeout`. R30 Solution/Human feedback records the
related facts-as-file representation and unsupported recursive wire shortcut.
R31's previously inspected bounded action-window lesson also applies, without
reopening that platform lane. R34 optional omission is a comparison, not proof
that its hypothetical fix solves a required-file failure. Do not infer a single
shared cause merely from task number or outerFAILED.

## Solution

No runtime candidate or speculative test. Required files cannot safely become
optional, missing driving proof cannot be waived, and recursive schema support
or unlimited history would exceed this bounded evidence. A general repair
would need original-context causal proof that it preserves complete requested
facts using a valid schema and bounded evidence, plus unchanged task outcome.
The existing immutable packet supports a precise OPEN floor instead.

The next distinct evidence needed for the observed400 would be the original
storage response and request metadata; no live query was made to obtain it.
Any future work must keep this storage observation separate from the task's
coverage and schema requirements. No timeout/cap/retry/model/provider/prompt/
criterion changes, no runtime application, no new paid or browser/API/DB call.
Investigator tokensUNMETERED.

## Human feedback

The parent required source-bound original triage, prohibited assuming earlier
BU055/schema/rebind cases recur, preserved infraFALSE and the original deadline,
and limited work to the existing packet. Missing genericFAILED cause was not
permission to classify provider infrastructure or force a task result.

## Reusable lesson

Separate generated artifact requirements, retained evidence coverage and actual artifact-delivery failures before attributing a late browser timeout to one repairable cause.

## R43: independently observed BU055 run2 recurrence

The new original is jobr002-j0020, root7ef6071a-5d30-44c6-8f9c-d1d8ddb75cb6,
fleet20261029-002843-2095876, executed at unchanged765caac00ce085dd0359b8342161a8717be7446d
with workspace_patch_sha256=none. It remains nativeFAILED/taskFAILED after
3012.9seconds, infra_failure=false. The bounded intake began at approximately
2026-10-29T01:31Z. Normal archive SHA256 is
1283fcfd8edf13b5e5ed2c4bbfe465890e2564a83b2351c031bc9a13f7f89394;
manifest9ab3246f9d5c2bcad1e11a74e0be64c33e583393b936c1ab4d0d64cff6eb0e82
and all seven member sizes/hashes verify. Run and full-worker hashes are
ea0b3eeb1c7e8b30ee5b3dfdd81ead3a9bedc74de488f9cc042df315bd0603a8 and
bfd332dc8c73a6efd0a0f79cd660895ac79961b17e1f1576103343b6a352e6ad.
Supplemental lifecycle data is separately labelled; no physical release state
is inferred from the task outcome.

This occurrence was grouped only after opening its original schema and input.
The schema generator's first response reaches its length limit with no JSON.
The next actual responsee2a5879beea6 emits required restaurants:list[file_pointer]
with minItems=maxItems=3 inside each supercharger. Its recorded reasoning
explicitly considers nested restaurant objects, identifies the native nested
field enum limitation, and emits file pointers. This supports a concrete
representation limitation, not proof that a legal flattened alternative could
not have completed the task. The later general schema capability repair was
not executed in this original run.

At01:00:25.347906Z verifier562c9ed2b2d5 receives a compact action window25..54;
its separate evaluate steps are54,52,50,48,46,44,42,40,38,36,34,32,30,29,26.
Earlier executed step10 contains the Tesla Bloomington East3rdStreet card and
2894 E3rdSt address, step12 the Fresh Thyme Market card/3600 W3rdSt address,
and step24 the Tokyo Japan Sushi & Hibachi name/address/Maps URL. The specific
'East 3rd Street' and 'Tokyo Japan Sushi & Hibachi' strings are absent from both
raw context and encoded request. Fresh Thyme Market text is still present
elsewhere, so this is not a claim that every mention of the western site vanished.
The full earlier evaluated receipts are outside the separate receipt selection.
Step10/12/24 message SHA256 values are respectively
dde93ab527dd648f316fc08a065aea821c8d6baecc5c8489d4dfcdcbbe016469,
ab303e833c21e6ddc362db923ec78a46161ccfeddb456f86a3d9f1205e11f5b4,
and c6f45b8f6179de779044c2262710672edb6244664344a0d5e549a329044eac26.

The actual converter exactly reproduces the captured request after excluding
its separately inserted schema-system message. Budget use is33470/160000,
with one per-tool truncation. Thus these omissions precede budget exhaustion.
Raw context SHA256 is5c57b425f9d24bcf11996b17a58a78188601a2be20296e2dcbe1ce8df8244c6f;
request SHA256 isf0754d6f313aa42ffc8b70e23622537eb70a01d23b3bd2ac5d90680b24fbd368.
The response explicitly rejects missing Tesla-sourced addresses, the third
Evansville restaurant name/URL, full coverage and required files. It returns
score0.5/task_completed=false; session_files reports no downloaded files.
Unlike run1, this intake has not established any failed file-upload request.

The actor continues collecting addresses through step79. Temporal reports
activity StartToClose timeout at01:24:32.632544Z, and the root fails. There is
no later captured completion verifier or final successful answer. A prior
15-second evaluate timeout recovered and subsequent evaluate calls succeeded;
that event alone does not explain the final50-minute exhaustion. The later
'Agent paused by user' and browser cleanup-failed messages are retained as
emitted, not interpreted as new user action or as the cause of the task failure.

This is an additional original observation of the same required-file and
bounded-evidence mechanisms, not a regression of pending repairs. The scoped
full-history evaluate-candidate repair9994210 and the separate nested-schema
capability repair were not in executed765. No duplicate repair, test, timeout
change, task rewrite or model replay is proposed here. Whether either repair
changes this task's actual outcome remains OPEN. The last-call, artifact,
semantic coverage and final-timeout limits remain distinct. No new browser,
provider, model, DB, capture or image operation was performed. TokensUNMETERED.

## It14 BU055 run1 positive control (2026-10-29)

Bounded comparison began03:11UTC. Original R37/R43 clocks and failures remain
unchanged. This independent run uses85d37fc8ab8e284459977debdef34348d825ef84,
workspace_patch_sha256=none, root aeb20b17-7262-411a-8d22-37d96ea9afd1,
jobr001-j0005. NativeCOMPLETED/passed=true after2066.2seconds; canonical
TASKPASSED at03:05:41.922054, infraFALSE. Archive SHA256
5012b85a5b4a09d429ae02c52a44c7dcda01d81291df727200d8ab2744914dc6,
normal manifest7435b5d8daac4a1bbf75f2f4919fcba94b7aea1c8eb9b3d6248e861c9e0c300b,
and all seven original member sizes/hashes independently verify. Run SHA256
0981d594469e58f8feb842c4499004d4d2262bfbc8412e1b85c7feeb2810ad3d.

Actual schema generator798f2cb0d7ad emits the finite node wire with
superchargers:list[object] and nested restaurants:list[object], minItems=maxItems3,
then name/address/google_maps_url string children. It does not request restaurant
file pointers. The captured reasoning explicitly chooses a bounded inline
collection. This is observed use of the new representation, not inference from
an aggregate PASS. Generator request payload SHA256
8a558e0b054309d091b132f91df7d592ad3d0e2f62ed1afa9fd1880033634a0a.

Actual encoded verifier request543a199bca18, payload SHA256
9c553f93b71cb5dfcb31802dd02f33710ce9e323cc1728d19a332e9ad4327c7e,
advertises that nested schema and admits eighteen separate evaluate receipts:
43,41,39,34,32,30,27,25,23,21,19,17,15,14,13,11,9,8. Its compact action-history
text reports30 actions shown but is itself bounded; its surviving step headings
are10,15,16,17,33 through43. Receipts8 and9 are independently retained
beyond even its earliest surviving step.
Those older receipts contain the alternate-source Supercharger dataset and
filtered city/address records. The final input also retains actual route
results at23/25/27,30/32/34,39/41/43: respectively0.3/0.3/0.6mile,
0.6mile/479ft/0.3mile, and0.1/0.2/0.2mile. These are captured tool observations,
not fresh external verification. Separate route receipts23/25/27/30/32 are
also absent from the surviving bounded action-history text. This distinguishes
full receipt admission from the compact text, but does not by itself separate
original action selection from per-tool head/tail truncation for those routes.
Tesla's site returned Access Denied; the actual verifier acknowledges alternate
sources rather than pretending Tesla access succeeded.

The paired verifier response returns score1/task_completed=true and inline
three Superchargers with three named/addressed/Maps-linked restaurants each.
The separate declared evaluator returns C1/C2/C3 allPASS with no screenshots
sent. The source's schema and full-history changes were both present, alongside
other source/model/trajectory differences. No controlled ablation establishes
which change caused the PASS or that either would repair originalR37/R43.
Original required-file, upload400, missing-evidence and timeout observations
remain OPEN. No runtime edit, new test, model/API/browser/provider/DB call,
image viewing, fresh capture or regrade was performed for this comparison.
