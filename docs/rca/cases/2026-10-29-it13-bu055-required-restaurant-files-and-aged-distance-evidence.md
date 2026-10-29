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
