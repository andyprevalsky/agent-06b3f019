---
id: 2026-10-18-responses-system-boundary-marker-survives-final-trim
date: 2026-10-18
title: Responses instructions retain the final internal system boundary after whitespace trimming
surface: agents
component: rose-responses-system-serialization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: System text trimming removes the final delimiter newline before wrapped-boundary splitting in Responses instructions
symptoms:
  - Reserved internal system marker appears in real provider-body instructions
  - Real system-prompt producer violates the existing no-model-visible-marker contract
tags:
  - responses
  - serialization
  - system-prompt
  - cache-prefix
sources:
  - commit 2a798afc5f2d3147e27af5ea488baa5d600cc48d
  - plan:.context/auth-deploy/repair-native-original30-2a798af-20261017/assistance-declined-failure-rca/serializer-owning-candidate/final-proof.json
repro: agents/tests/blackbox/rose.blackbox.py
status: open
---

## Problem

The real `build_system_prompt` producer appends a newline-wrapped reserved
system delimiter after the output-field section. Responses `_build_system_text`
strips each system message before `_build_instructions` splits on the complete
newline-wrapped delimiter. The final delimiter therefore becomes a bare token
and survives into provider instructions. This contradicts the explicit
client contract that internal system boundaries are never model-visible and
the existing registered `codex_responses_body_contract` assertion.

This formatter defect was found during an input-fidelity audit of a separate
native declined-auth failure. It is not established as that failure's cause.
No model, provider, browser, backend or financial call was made by this
reproduction. The actual source reconstructed body and normalized-dump body
also differ in cache affinity: dump normalization loses static-scope metadata.
That reconstruction limitation is separate from this serializer defect. The
original producer's static MAIN cache scope was correct and remains unchanged.

## Diagnosis

Actual owning path: real root-system producer with User Context, current phase,
and custom output `fields` -> real Responses body builder -> instructions.
The new regression extends the existing automatically registered Rose owner;
it does not reimplement the formatter or score model behavior. A timing event
was recorded before reproduction at 2026-10-18T00:19:34.927405Z.

Against unchanged physical source 2a798af, the selected owner failed on the
reserved-marker wire assertion. Preceding assertions retained ordered semantic
sections, native six-tool projection, literal USER/TOOL marker-like data,
call IDs, and static MAIN cache-scope invariance. Expanded identical controls
also fail on a standalone whitespace-wrapped delimiter before the candidate.
All 915 previous assertion ASTs and their multiplicities are retained; the
final private test module has 932 assertions.

The canonical exact-source 940-case archive searches were
`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and
`_build_instructions trailing sentinel cache-scope`. The exact search had no
hit; 23 broad relatives included the September 10 native completion-selection
causal-proof gap and October 16 fresh-clock/cache-prefix case. Their full
Solution and Human feedback sections were read. Neither proves recurrence of
this final-delimiter trimming mechanism. September 10 warns against treating
normalized dump/cache-affinity controls as historical wire or causal repair;
October 16 requires preserving native body/cache boundaries. Those limits
apply here. This is a distinct serializer case, not a fork of the unresolved
auth-decline case.

## Solution

A private candidate changes only `_build_instructions`: segment system text
on exact reserved delimiter lines, allowing boundary-line spaces, tabs and CR,
then retain the existing paragraph strip/join behavior. Ordinary text is split
only on LF and rejoined unchanged; embedded CRLF and Unicode separators remain
intact. Inline marker-like prose is preserved. No global token replacement or
USER/TOOL filtering is added. Static-cache-scope logic and all other runtime
module ASTs are unchanged.

The same selected owner with the same assertions fails on the unchanged
formatter and passes on the private candidate. Four pure registered owners
(body contract, tool history/multimodal, orphan-tool conversion, cache session
headers) pass together with zero network attempts. Controls cover real final,
leading and interior markers; whitespace boundary lines; multiple system
messages; inline marker-like prose; ordinary CRLF/Unicode data; preserved
non-system payloads/protocol IDs/tools; unchanged cache affinity across dynamic
context/schema/phase changes; and distinct affinity when MAIN or namespace
changes. The first candidate test attempt omitted a required `request_id` in
the new multiple-system fixture and raised TypeError. That setup failure is
retained; the successor fixture adds only the required argument, retaining all
assertions and unchanged candidate runtime before the final RED/GREEN.

Private proof: `serializer-owning-candidate/final-proof.json`, code/tests patch
`candidate.patch`, original RED in sibling `serializer-owning-red`, corrected
logs in `controls-v2`. No full Rose or benchmark registrar was run, because its
unrelated eager helpers can require funded/native work. No rollout or shared
source adoption occurred. This case remains OPEN pending central integration
and normal verification. The separate declined-auth native failure remains
OPEN; its two normalized selected-provider nonreproductions and low-power
six-case panel are retained with their original fidelity qualifications.

At large fleet scale this adds only a linear pass over the system text already
being serialized; it adds no network/DB calls, polling, per-agent shared state,
locks, schema changes or tool execution.

## Human feedback

The user authorized fixes before deployment approval and required preserving
existing task budgets, evaluator contracts and assertions. The coordinator
specifically scoped this work to the proved serializer contract, with pure
owning RED before candidate, no actor/verifier prompt change and no claim that
serialization explains the declined-auth incident. The earlier human
cache-preservation requirement in the October 16 relative remains respected.

## Reusable lesson

Verify an internal delimiter at the actual producer-to-provider-body boundary,
including final whitespace trimming. Keep system-only serialization separate
from user/tool data and cache-scope reconstruction; a deterministic formatter
fix does not establish the cause of a model's prior choice.
