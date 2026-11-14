---
id: 2026-10-28-it13-bu056-optional-crew-file-field-omits-announced-people
date: 2026-10-28
title: It13 BU056 omits known crew details through an optional file-pointer field
surface: harness
component: response-schema-generation-and-browser-verification
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: generated crew_members is an optional file-pointer list; native verifier knows crew facts but omits that field because no files exist
symptoms:
  - polar perfect-score failed (2/3 rubrics)
  - final structured output omits those crew details
  - crew_announced true
  - optional crew_members field expects session file pointers
tags:
  - polar
  - it13
  - r34
  - generated-schema
  - semantic-coverage
sources:
  - commit 765caac00ce085dd0359b8342161a8717be7446d
  - agent 2f477a37-b408-44c4-8bd3-1b15b8f5d94a
  - fleet run 20261028-230247-3988107
  - plan: archive 52884a76cff5404156ca587257ef1f6fbf2a6b301693396d53d553e36278d467
  - plan: normal manifest 213049da62939d97e9840b4fba5535f7009bf9cff6cf8268b77c0a2b1430a960
repro: none-recorded
status: open
---

## Problem

BU056 r1 asks for NASA's upcoming launch events, official event links, crewed
status, and full names, nationalities and biography links for announced crews.
The original root completes in246.4seconds, but the task is FAILED: C1 and C3
pass, C2 fails because the final structured output omits announced crew details.
Original infraFALSE, source765caac/no patch and task grade remain unchanged.
Assignment clock2026-10-28T23:18:39.639949Z is retained.

All seven normal runtime members and separately labelled supplemental receipts
match SHA256SUMS. Original run.json SHA256 is
 e07e44d64b6d0a050679ec965bf26fa209924c8be7fe6bbdb526caf05d544952.
No current NASA request, model call or image inspection was performed.

## Diagnosis

The captured schema generation request11d407b671cf has SHA256
 eeda88999d4e087c4ef19b4ae0ca7ed9bb6828d9202863c9746c89ab18f9894a;
its response SHA256 is
 e923fbdfa2cc885b28ade2330bdfd80cd7f9ead3b7e2232dd6a22a4e9bd8d121.
The generator reasoning explicitly requires crew names, nationalities and profile
links. Its emitted launch_events:list[object] instead represents crew_members as
list[file_pointer], required=false, nullable=true. It includes ordinary inline
name/link/crewed fields for events. The same crew field is present in original
browser-start and browser-completion metadata, so this is not a later renderer
inventing or dropping that schema.

Native verifier request648cffda89d3 SHA256
 a5835805a1e9ce6de3d077fc4bc5d252cc058364d79526ef9832a8e557308758
contains the names Randy Bresnik, Luca Parmitano, Andre Douglas and Frank Rubio
in original evidence. Its response SHA256
 d2b3568d27265e3ccdf248d58c025d1331fbf1e635641ab8ebca45234537de51
repeats names, nationalities and biography links in reasoning, then explicitly
says that optional crew_members expects session file pointers and no files were
downloaded, so the field is omitted. It returns task_completed=true and score1.0.
Its structured13event list has Artemis III crew_announced=true but no
crew_members field. No evidence loss is needed to explain this local omission:
the actual native verifier knows and describes the facts it leaves out.

Root message71 at23:12:07.205Z says the completed child covers the required
fields, nasa_launches_page_url and launch_events. Its final structured event
list preserves the missing crew details. Exact source
helpers/llm.py:check_progress accepts an existing completed child structured
response when it satisfies the schema; it does not invent missing factual
fields. The final completion-summary response independently acknowledges the
omission. Original declared judge C2 rejects the final answer, while C1/C3 pass.
No original judge request wire parity or counterfactual model outcome is claimed.

The local read-only `.context/rca-r34/inspect_original.py` checks all receipts,
compares original schema metadata, confirms four names occur in captured native
input and reasoning, and confirms they are absent from the final structured
answer. It passes unchanged. This is custody/output tracing, not a causal repair
RED-GREEN control or proof that the unchanged task will pass after a repair.

Archive searches `optional file schema omitted facts` and
`crew members nested schema` led to R30 BU058. Its full Solution and Human
feedback were read. R34 shares the observed optional-file representation hazard,
but the actual R34 generator does not explicitly attribute its choice to nesting
limitations. The source's nested type vocabulary excludes object/list[object],
while flat rows and inline strings remain legal. Therefore a generalized
recursive-schema repair is not proved necessary or sufficient here. R30's
recorded native wire expansion floor remains a limit, not a new investigation.
This is not R24's public/internal file-pointer admission mismatch: the original
field is admitted and propagated, then omitted under its own optional semantics.

## Solution

No runtime candidate. Keep this separate original occurrence OPEN and preserve
the genuine task failure. The useful future proof must establish a general
schema-generation/semantic-coverage contract that delivers requested facts with
valid inline or actual-file representations, then prove the same owning
boundary and unchanged task outcome. Merely requiring every optional field can
demand nonexistent artifacts; changing file pointers to arbitrary dictionaries,
forcing task-specific crew fields or reopening recursive provider serialization
would not be a grounded bounded repair.

No prompt, schema, criterion, cap, timeout, provider, task grade or live source
changed. No model replay, browser/API/DB/provider call, image output or new
capture occurred. Existing R24/R30 cases and the active campaign remain untouched.
Investigator tokens are UNMETERED.

## Human feedback

The parent required a fresh original trace instead of assuming R30/R24 recurrence,
kept active765caac frozen, prohibited recursive-platform reopening and task or
expected-answer changes, and requested a bounded repair decision. This intake
records the semantic omission but makes no full benchmark repair claim.

## Reusable lesson

Distinguish facts present in native evidence from facts deliverable through the generated output schema before blaming downstream transport for an incomplete final answer.
