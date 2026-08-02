---
id: 2026-07-11-reasoning-commentary-parsed-as-final-answer
date: 2026-07-11
title: Streamed structured-output parsing lost item boundaries, so commentary/reasoning reached SMS as the answer
surface: cross
component: rose-client
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the streamed OpenAI/Anthropic response parsers collapsed output items without preserving boundaries or provenance, so a non-final item could be selected as the final answer
symptoms:
  - SMS reply contains model commentary or reasoning instead of the final answer
  - structured-output consumer reads the wrong output item from a streamed response
  - TypeScript and Python stream parsers disagree on the same provider payload
tags:
  - rose-client
  - streaming
  - structured-output
  - sms
  - cross-language-contract
sources:
  - PR #754
repro: none-recorded
status: fixed
---

## Problem

Structured-output consumers — SMS delivery among them — were emitting model
commentary/reasoning text instead of the declared final answer. The two client
implementations (TypeScript and Python) parsed streamed OpenAI/Anthropic responses
differently, so which text a consumer received depended on which language's client
made the call.

## Diagnosis

The streamed-response parsers did not preserve item boundaries or output
provenance: separate output items (reasoning, commentary, final answer) were
flattened, leaving downstream consumers with no way to identify which item was the
declared final answer. Any consumer that just took "the text" could therefore take
reasoning. Because the parsing logic was duplicated per language with no shared
contract, the two clients drifted, and no fixture pinned the provider payload shape
across them — so the bug could exist in one client and not the other with nothing
failing.

## Solution

Standardized streamed-response parsing across TypeScript and Python so item
boundaries and output provenance survive parsing, then made consumers select the
_explicit_ final-answer output and exclude commentary/reasoning. Cemented with
shared cross-language contract fixtures plus parser regression coverage, so the two
implementations can no longer diverge silently. The same PR added an executed
local-repro requirement to `docs/root-cause-analysis.md` and repaired
layering/dependency-boundary issues that deploy verification surfaced (baseline
request-payment layering, onboarding dependency boundaries, blackbox proxy
isolation).

## Human feedback

The RCA guidelines were amended in this same change to require an _executed_ local
repro, which the record presents as a standing requirement on diagnoses of this
kind rather than as optional practice.

## Reusable lesson

Parse streamed provider responses into explicitly-labeled output items and have
consumers select the declared final answer — never the concatenated text — and pin
the shape with one shared fixture set when the same parser exists in two languages.
