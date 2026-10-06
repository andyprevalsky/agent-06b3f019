---
id: 2026-10-03-render-backend-wrote-llm-context-dumps
date: 2026-10-03
title: The Render backend wrote full LLM context dumps to its disk because the dev-only dump writer detected production only through Fly's FLY_APP_NAME
surface: back-end
component: llm-dump
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/providers/llmDump.ts `IS_PRODUCTION = process.env.FLY_APP_NAME !== undefined`, copied from the agents helper that runs on Fly; the backend runs on Render, which sets NODE_ENV=production and no FLY_APP_NAME
symptoms:
  - "llm.context.dumped"
  - "/opt/render/project/src/.llm-dumps/"
  - "no .llm-dumps directory for"
tags:
  - llm-dump
  - render
  - privacy
  - prod
sources:
  - PR #1341
repro: `back-end/src/tests/unit/llm-dump-production.test.ts` sets NODE_ENV=production with FLY_APP_NAME unset; before the fix `dumpLlmContext` returned a path and wrote the file, after the fix it returns null, writes nothing, and `updateLlmDump` leaves an existing dump untouched. Non-production runs still write dumps.
status: fixed
---

## Problem

While publishing evidence for this deploy, a chat-mode agent had no
`.llm-dumps` directory. Looking at why led to the backend dump writer, and to
the finding that the prod backend writes dumps. Render's prod log shows
`llm.context.dumped` entries under `/opt/render/project/src/.llm-dumps/` as
recently as 2026-10-02, from `challenge_llm_classifier` calls.

## Diagnosis

### Evidence

- `llmDump.ts` returns early only when `FLY_APP_NAME` is set. Its header says it
  mirrors the agents helper, and the agents run on Fly.
- `render-env.ts` lists 128 variables on the Render service: `NODE_ENV` is
  `production`, and there is no `FLY_APP_NAME`.
- Render request logs contain `LlmDump llm.context.dumped` with Render project
  paths.
- The dump callers are chat compaction, the browser challenge classifier, and
  the credential-propagation classifier. Each dump holds the full messages:
  page text, user messages, and model output.

### Root cause

The production check was copied from a Fly-hosted service into a Render-hosted
one without a matching signal. On Render the dev-only writer stayed enabled. It
put prompt contents on the instance disk and grew without bound until the next
deploy replaced the disk.

## Solution

`llmDump.ts` now treats either `FLY_APP_NAME` or `NODE_ENV=production` as
production, checked on each call. Both `dumpLlmContext` and `updateLlmDump`
skip writes there. Local stacks and the blackbox harnesses run with a
non-production `NODE_ENV` and keep their dumps. The unit test
`llm-dump-production.test.ts` failed before the fix and passes after.

The backend chat router and generator still pass no `dump_context`, so
chat-mode agents have no local LLM dump to publish as evidence. Adding one was
left out because it would have written a dump for every prod chat message
before this fix.

## Human feedback

None recorded.

## Reusable lesson

A "skip in production" guard has to use a signal the hosting platform actually
sets. When code moves between platforms, check the guard against the target's
real environment, not the one it was copied from.
