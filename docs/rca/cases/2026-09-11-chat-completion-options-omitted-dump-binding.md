---
id: 2026-09-11-chat-completion-options-omitted-dump-binding
date: 2026-09-11
title: Chat completion options omitted the agent binding required for LLM evidence
surface: back-end
component: chat-completion-options
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: Router and Generator completion option builders omitted dump_context before entering the Rose client
symptoms:
  - "no .llm-dumps directory for af3d9517-2dd9-4e89-9201-b1cc772425d8"
  - "chat-mode passes with two live LLM calls but evidence publication fails"
tags:
  - chat
  - llm-context-dump
  - evidence
sources:
  - PR #1299
  - agent af3d9517-2dd9-4e89-9201-b1cc772425d8
repro: back-end/src/tests/blackbox/llm-stream-contract.blackbox.ts
status: open
---

## Problem

The 2026-09-11 Group 4 `chat-mode` task passed in 16.7 seconds with two
LLM calls, while `publish_evidence_links.py` failed because the root had no
LLM dump. Fast cache replay was disabled; provider prefix-cache hits are not
application replay. Nine other runs published, and the two missing artifacts
were retained as explicit failures in `group4-ce406-durable-evidence.json`.

## Diagnosis

The backend Rose stream writes context only when options include
`dump_context`. Both chat phases have the root agent ID available, but their
option builders omit that binding. The actual client completes successfully
without invoking its capture path. This is distinct from Python's fast-cache
early return, tracked in the July 7 case.

The permanent stream-contract regression drives both real option builders
through `createStreamingCompletion`, replacing only the external HTTP
transport with the shared provider SSE fixture. Both phases return their
expected output, then fail on the missing agent directory before the fix.
`chat-before-corrected.log` records those two failures; `chat-after.log`
records the same assertions passing after the binding is supplied. The test
asserts full current messages, response format, agent identity, completed
output, exactly one dump per phase, and exactly two transport calls.

## Solution

Bind each live chat phase to its agent and call site when constructing the
completion options. Reuse the Rose client's existing start/finalize capture;
retain all model routes, prompts, response schemas, generation parameters,
hedges and time limits. This does not change chat's separate application-cache
synthetic stream; that path was not the observed failing boundary.

All three existing chat option/provider-route suites and the shared
stream-contract blackbox pass. The exact unchanged `chat-mode` rerun passed in 16 seconds with root
`510f11f5-15be-4416-8fb1-db53c12a41c9`; its publisher verified the production
FE, six messages, and its LLM dump. Both phase dumps exist, and the exact
local database container and volume were independently absent afterward.

Independent review also reproduced a second boundary: consumer return from
the TypeScript async generator skipped ordinary finalization code. A common
idempotent finalizer now runs in `finally`, preserving partial output before
returning and recording `consumer_closed`. Existing error paths retain their
original errors; no provider calls are added. The permanent real-client SSE
test fails for both early-return phases before that fix and passes afterward.
The reviewer's unchanged independent reproduction also passes. The shared
chat parameter type removes duplicate declarations and requires agent
identity without changing runtime options. ESLint and TypeScript pass.
The case remains open through the final combined-tree gates. Private artifacts are under
`.context/acceptance/completion-dump-rca/`.

## Human feedback

The user requires normal 120-minute task backstops with a temporary five-minute
limit for this validation, no repeated permission requests, and completion of
ten sequential ten-task cloud slices. No timeout or evaluator changes are part
of this capture fix.

## Reusable lesson

Bind evidence identity at the completion boundary. A successful streamed
response does not prove that its input and output were retained for review.
