---
id: 2026-11-16-schema-generation-retries-repeat-rejected-selection
date: 2026-11-16
title: Schema generation repeats a rejected selected-field mismatch without feedback
surface: back-end
component: response-schema-generation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: setResponseSchema.ts generateResponseSchema retries semantic rejection with identical request messages
symptoms:
  - 'Expected status 200, got 500: {"error":"Failed to generate response schema"}'
  - Value presentation must select the only required nonnullable non-file output field
  - Unsupported JSON schema fields in schema with keys
  - schema must have a 'type' key
tags:
  - response-schema
  - selected-field
  - provider-compatibility
sources:
  - PR #2403
  - commit 770611c7c2e3ad3e066c2ee703e87c28f0e50d4f
repro: back-end/src/tests/blackbox/response-schema-retry.blackbox.ts
status: open
---

## Problem

Native failure: https://github.com/Rose-Ai-Labs/rose/actions/runs/43893687982.

The existing caller-root archive blackbox failed its HTTP200 assertion twice
(2612ms and625ms), before checking archive paths. Native captures contain six
identical malformed completions: sole field tokyo_population, selected field
population. The strict canonical validator correctly rejects them. These are
FAIL attempts, not FLAKY. Original evidence is privately preserved by receipt
537f5a340e71471a7a08ef4f6530648d136772e0d5a92b75145a54dbc11e6565;
all21124 files restored on the independent Bugs devbox before investigation.

## Diagnosis

Authenticated route -> generateSchema -> generateResponseSchema -> Flash ->
Cerebras400 (untyped const unsupported) -> Foundry400 (missing type) ->
OpenRouter200 -> parser -> validateFinalPresentation -> repeated rejection ->
HTTP500. Schema author can produce semantically inconsistent names, and its
native grammar cannot express dynamic equality across two generated fields.
The owning recovery loop retries without the rejected response or error,
therefore exact-request caching repeats the same output. Untyped const and
untyped enum independently cause provider compatibility rejection.

Gate: NOT_INTRODUCED, native HEAD0e65e3c0747c71c6dc742994285771eda1462f45
versus base d40e1e11692b84a6859aee1f4f80858b73b1b553. Exact original
request-checked transport replay fails on both,91 compiled source inputs
identical. This assigned repair remains owned irrespective of attribution.

Archive searches: Failed to generate response schema; presentation field
selected; exact Value presentation validator message. R108 native-mode-shape
and R78 final-presentation are relatives. R108 expressly excludes dynamic
selected-name semantics; its solution does not correct this retry boundary.
No exact active owner was found by reading actual project thread work;
presentation owner received the distinguishing evidence before edits.

## Solution

Candidate uses typed singleton enums (same accepted objects), preserves strict
canonical semantics, and retains the actual rejected completion plus actual
validator error for the next bounded attempt. No goal-specific hint, answer
rename, cache clearing, accepted-object broadening or budget increase. Original
system prompt, auth, archive binding, three attempts,2000/4000 escalation and
backoffs remain. Retry state is invocation-local, holding one rejected response,
so10000 concurrent agents have no shared coordination or fan-in.

The original transport repro exited1 with HTTP500 on both original revisions.
The strict recovery repro retains the original malformed first output, checks
all initial request bodies except the typed-enum delta and its derived Foundry
cache key, and matches the corrective request to its real captured response.
`NODE_PATH=/home/boxes/rose/node_modules node .context/schema-repair/replay/recovery-replay.cjs head`
exits1/HTTP500 in0.875s; the same oracle with candidate source exits0/HTTP200
in0.449s with zero swallowed transport violations and caller-root records.
These scripts/captures are privately preserved; the permanent blackbox contains
the exact native bad bytes and recorded provider continuation, not a hand-edited
answer. Valid output is used only after the real validation-feedback request.

The permanent regression now covers feedback-dependent recovery, persistent
rejection within3 attempts, report/value controls, multi-field and nested-file
negatives, unchanged2000/2000/4000 truncation behavior, fatal400/401 fail-fast,
and all3 caller-root start/final pairs with exact rejected bytes/feedback.
It explicitly joins the existing asynchronous capture owners before reading
records. Five unchanged runs and independent flakiness review passed; canonical
path and final native qualification are recorded in the deployment receipts.

The unchanged original agents suite passed (68923ms; original archive case461ms).
On the first frozen repair source a71cc5fdee826148c58ddd48dab33623ceaeb951,
all17 native gates passed. Owning Blacksmith run43905320069 passed all287
cases, with the exact original archive case PASS313ms. Its assertion file and
finalPresentation.ts are byte-identical to the original source. Actual
corrected-schema acceptance is separately demonstrated on Cerebras and Foundry
(HTTP200); replaying original400s is not provider-acceptance proof.

Independent RCA reconciled every causal/control objection. Golden approval
schema-retry-2 is GROUNDED at that frozen source, scoped diff SHA256
78fb93198069116b3d16529ac317acef9a7fd104ad1b5aa184e827a15414824b,
reviewer ph793p8hynymab1kkh93eknxsh8ja1az. The provider source bytes remain
unchanged in stabilization. References: Instructor handlers.py321-340/950
at1e85ddf38807084182aeefb5bb67f4deee821163; Pydantic AI anthropic.py335-358
atc7586d79b64706f4605f15a29534118813df12a4; Vercel parse-and-validate-object-
result.ts52-59/87-109 at8ba3940d3dd1f3cd3c4365bbaec505c6ef0eb1e3.
Latest-only/first-error feedback differs from accumulated/fenced structured
feedback, but leaves acceptance and retry limits unchanged. Extra input tokens
increase retry prompt cost; unchanged completion caps do not imply unchanged
spend. This proves selected-field repair, not general presentation-intent
compliance or guaranteed model reliability. PR2404 remains pending final
stabilization verification, merge and production checks; status remains open.

## Human feedback

Preserve strict finalPresentation semantics, original captures, archive binding,
all native attempts and budgets. Do not substitute a valid fixture for the
original rejection or claim a lucky live retry as sufficient repair proof.
Own repair through completed deployment on this separate Bugs devbox.

## Reusable lesson

A structured-generation retry must receive its real validation failure while
retaining strict acceptance rules; unchanged cached requests cannot repair a
semantic inconsistency.
