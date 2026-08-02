---
id: 2026-07-19-final-text-called-outside-the-supervisor-try-catch
date: 2026-07-19
title: SMS supervisor called `finalText()` outside its try/catch, so a reasoning-only stream threw and sent an apology instead of an answer
surface: back-end
component: sms-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: providers/smsSupervisor/supervisorHandler.ts callSupervisorLlm — StructuredOutputAccumulator.finalText() was invoked outside the try/catch meant to never send raw garbage to the user
symptoms:
  - "Sorry, something went wrong." SMS reply with no agent spawned
  - "StructuredOutputCardinalityError: Expected one structured output item, received 0"
  - recurring on separate turns from the same prod user
tags:
  - sms-supervisor
  - structured-output
  - rose-1-lite
  - error-handling
  - prod-incident
sources:
  - memory:project_sms_supervisor_empty_stream_crash
repro: back-end/src/tests/blackbox/sms-supervisor-stream.blackbox.ts
status: fixed
---

## Problem

Prod incident 2026-07-19: user `5824c58c` texted "where can I get chicken wings
near me" and received "Sorry, something went wrong." No agent was spawned — the
failure was in the backend SMS Supervisor
(`providers/smsSupervisor/supervisorHandler.ts`), not the agent workflow. It
recurred on the same user's "tennis racquet shock absorbers" turn, and nothing
was committed either time.

## Diagnosis

`callSupervisorLlm` consumes the `rose-1-lite` stream. When the model emits
neither native `tool_calls` nor any emittable content item — a reasoning-only or
empty structured response, which is a known transient signature — the handler
called `StructuredOutputAccumulator.finalText()` _outside_ the try/catch that
exists specifically to never send raw garbage to the user. `finalText()` throws
`StructuredOutputCardinalityError: Expected one structured output item,
received 0` (it also throws on >1 items and on ignored-phase-only streams). The
throw escaped through `handleSmsSupervisorMessage` → the `routeToSupervisor`
catch → the generic error SMS. The deeper owned cause is a mis-scoped guard: the
accumulator's strictness in `providers/rose/structuredOutput.ts` is by design, so
the caller must contain it — and the parse call sat one line outside the boundary
that was supposed to contain it.

## Solution

Extracted `finalizeSupervisorResponse()` as an exported seam and moved
`finalText()` inside the try/catch; on a cardinality/parse failure it now returns
`{ reasoning, tool_calls: [] }`. Empty `tool_calls` routes into the loop's
existing nudge-and-retry path (bounded by `MAX_TOOL_ROUNDS=10`), so a transient
empty stream gets another round to actually answer, and only if every round stays
empty does the loop's terminal net deliver one apology. This also deleted the old
bespoke apology + `attempt_completion` injection that gave up on the first empty
round. Regression test:
`back-end/src/tests/blackbox/sms-supervisor-stream.blackbox.ts` (standalone, no
live server, auto-discovered as domain `sms-supervisor-stream`) asserts that
zero-item, ignored-phase-only, and multi-item streams do not throw and yield empty
`tool_calls`, while native-tool and valid-answer streams pass through — proven
fail-before/pass-after. Known remaining test-depth gap: an end-to-end test feeding
a raw empty stream through `handleSmsSupervisorMessage` would catch a future
re-inline of `finalText` back into `callSupervisorLlm`.

## Human feedback

None recorded.

## Reusable lesson

A transient empty or reasoning-only LLM stream must degrade into the existing
retry path, not an exception — put every strict parse call inside the guard that
owns the user-visible output.
