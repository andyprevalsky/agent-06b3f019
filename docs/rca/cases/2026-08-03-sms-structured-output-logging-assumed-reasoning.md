---
id: 2026-08-03-sms-structured-output-logging-assumed-reasoning
date: 2026-08-03
title: SMS structured-output logging crashed when reasoning was omitted
surface: back-end
component: sms-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/smsSupervisor/supervisorHandler.ts finalizeSupervisorResponse logging
symptoms:
  - Cannot read properties of undefined reading substring
  - photo attachment returned Sorry I hit a snag after a six-byte nonconforming structured response
tags:
  - sms-supervisor
  - structured-output
  - logging
  - nonconforming-field
  - media
sources:
  - memory: test run 1785811212-40967-20905 SMS supervisor photo case
repro: back-end/src/tests/blackbox/sms-supervisor-stream.blackbox.ts
status: open
---

## Problem

The opt-in real-LLM photo case downloaded and attached the image successfully,
but the supervisor exhausted all three LLM retry attempts and returned `Sorry —
I hit a snag on my end and couldn't get to that one.` Each attempt logged six
content bytes, 199 reasoning bytes, zero native tool calls, then the terminal
error `Cannot read properties of undefined (reading 'substring')`.

The same suite's voice-note and greeting cases passed, isolating this failure to
the structured photo response rather than the SMS transport or the whole
provider route.

## Diagnosis

`finalizeSupervisorResponse` parsed the short structured content and then logged
`parsed.reasoning.substring(0, 300)`. The parsed JSON did not contain a string
`reasoning` field, so the logging expression threw before the normal empty-tool
nudge path. The trace does not prove actionable structured tool calls were
present; zero native calls were captured. The retry wrapper repeated the same
deterministic crash and finally sent the generic fallback.

The checked-in production-shape regression constructs the most plausible
short primitive response, JSON `"Red"`, with no native tool calls. Pre-fix it
throws on the same line; post-fix it returns zero tool calls so the supervisor's
existing nudge path can run. A sibling regression also preserves valid tool
calls when a nonconforming object-shaped response omits the schema-required
`reasoning`. The logger was the first bad owned boundary in both shapes.

## Solution

Tolerate nonconforming runtime `reasoning` by normalizing it to an empty string,
and normalize `tool_calls` to an empty array before logging or returning either
value. The deterministic stream suite
now passes all 13 cases: the primitive production shape nudges without throwing,
and the sibling object shape preserves its valid `Red` tool call.

This removes a throw and duplicate retries; it adds no query, state, lock, API,
privacy, or prompt change. At 10,000 agents it reduces wasted provider calls for
nonconforming responses that omit schema-required reasoning. Status remains
open until the unchanged real-provider photo case confirms the end-to-end path.

## Human feedback

None recorded.

## Reusable lesson

Normalize missing provider fields before observability code touches them, so
logging cannot invalidate an otherwise recoverable response.
