---
id: 2026-07-19-finaltext-called-outside-the-graceful-degrade-trycatch
date: 2026-07-19
title: SMS supervisor crashed because finalText() ran outside the try/catch meant to degrade unparseable streams
surface: back-end
component: sms-supervisor
classification: our-bug
problem_class: other
first_bad_boundary: "supervisorHandler.ts line ~655 — `callSupervisorLlm` invoked `StructuredOutputAccumulator.finalText()` before/outside the JSON-parse try/catch"
symptoms:
  - '"Sorry, something went wrong." sent as the SMS reply'
  - '"Expected one structured output item, received 0" StructuredOutputCardinalityError'
  - a reasoning-only or empty structured response from rose-1-lite crashes the supervisor turn
tags:
  - sms
  - supervisor
  - structured-output
  - rose-1-lite
  - error-handling
sources:
  - PR #807
repro: sms-supervisor-stream blackbox (5 cases)
status: fixed
---

## Problem

Prod incident 2026-07-19: user `5824c58c` texted "where can I get chicken wings
near me" and received "Sorry, something went wrong." When `rose-1-lite` returned a
reasoning-only / empty / ambiguous structured response — zero native `tool_calls`
AND zero emittable content items — `finalText()` threw
`StructuredOutputCardinalityError` ("Expected one structured output item, received
0") and crashed the supervisor turn.

## Diagnosis

`callSupervisorLlm` called `StructuredOutputAccumulator.finalText()` _outside_ the
try/catch whose whole purpose was "never send raw garbage to the user"
(`supervisorHandler.ts` ~line 655, positioned before the JSON-parse fallback). So
`select(requireExactlyOne=true)` threw from a spot the graceful-degrade path could
not observe, and the intended fallback never ran. The failure was not that the
model returned nothing — an empty stream is a normal transient outcome — but that
the code treated an expected model output shape as an unhandled exception,
converting a retryable round into a user-visible apology.

## Solution

Extracted `finalizeSupervisorResponse()` and moved `finalText()` inside the
try/catch; on cardinality or parse failure it returns empty `tool_calls`, which
routes into the loop's existing nudge-and-retry bounded by `MAX_TOOL_ROUNDS`. A
transient empty stream now gets another round to answer, and the loop's terminal
net delivers exactly one apology only if every round stays empty. This kills the
whole cardinality-error crash class — zero-item, ignored-phase-only, and
multi-item. Cemented as the new `sms-supervisor-stream` blackbox (5 cases).

## Human feedback

The repo owner authorized skipping the codex-code smoke domain for this deploy
(`BACKEND_CODEX_SMOKE_SKIP=1`) because both GPT quota sources were exhausted — an
external condition explicitly judged unrelated to this fix rather than something to
work around in code.

## Reusable lesson

Put the call that can throw _inside_ the try/catch that exists to degrade it — a
guard positioned before the risky parse protects nothing, and a model's empty
stream must be a retry, not a crash.
