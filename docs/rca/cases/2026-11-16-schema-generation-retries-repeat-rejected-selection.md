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
  - https://github.com/Rose-Ai-Labs/rose/actions/runs/43893687982
  - originating merge 770611c7c2e3ad3e066c2ee703e87c28f0e50d4f
repro: back-end/src/tests/blackbox/response-schema-retry.blackbox.ts
status: open
---

## Problem

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

The original transport repro exited1 with HTTP500. The recovery repro uses the
same original malformed first output, plus a real provider continuation captured
from the corrective request. Exact corrective-request matching returns HTTP200;
old source still returns HTTP500. These are mechanism checks, not a full gate.
The permanent regression includes unchanged native bad bytes, captured real
continuation, feedback-dependent recovery, persistent rejection at3 attempts,
ordinary report/value, wrong selection, optional/file/list negatives. Five
unchanged runs and independent flakiness review passed. Original agents suite
passed (68923ms). Required native gates, final review and deployment remain
pending; status stays open until that evidence is recorded. Replay's original
URL-only provider responses do not prove provider compatibility; separate
provider-path proof and tighter permitted-delta assertions are required.

## Human feedback

Preserve strict finalPresentation semantics, original captures, archive binding,
all native attempts and budgets. Do not substitute a valid fixture for the
original rejection or claim a lucky live retry as sufficient repair proof.
Own repair through completed deployment on this separate Bugs devbox.

## Reusable lesson

A structured-generation retry must receive its real validation failure while
retaining strict acceptance rules; unchanged cached requests cannot repair a
semantic inconsistency.
