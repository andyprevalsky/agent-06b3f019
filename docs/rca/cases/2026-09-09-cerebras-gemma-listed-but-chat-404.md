---
id: 2026-09-09-cerebras-gemma-listed-but-chat-404
date: 2026-09-09
title: Cerebras listed gemma-4-31b on /models but chat/completions returned model_not_found
surface: back-end
component: back-end/src/providers/rose/cerebrasRoute.ts
classification: third-party-failure
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/rose/cerebrasRoute.ts::CEREBRAS_CHAT_MODEL — gemma-4-31b chat 404
symptoms:
  - "chat model must not be archived: HTTP 404"
  - "Model does not exist or you do not have access to it."
  - "code\":\"model_not_found\""
  - "CEREBRAS_CHAT_MODEL=gemma-4-31b"
  - "FAIL  cerebras"
tags:
  - cerebras
  - gemma
  - gpt-oss-120b
  - model-not-found
  - chat
sources:
  - PR #1301
repro: back-end/src/tests/blackbox/cerebras.blackbox.ts
status: fixed
---

## Problem

`/deploy` backend coverage failed `cerebras.blackbox.ts` on the live probe:
`chat model must not be archived: HTTP 404 model_not_found` for
`gemma-4-31b`. `/models` still listed that id (catalog check passed). Same
class as `2026-08-20` `zai-glm-4.7` archive: every `direct-cerebras` chat
call 404s into the OpenRouter waterfall and misses the 5s lifecycle
ratchet.

Archive searches: `chat model must not be archived`, `gemma-4-31b
model_not_found`. Relative of the 2026-08-20 GLM cutover, not a
recurrence of a failed guard — the inventory check only looked at
`/models`, which lied.

## Diagnosis

1. Live Node fetch: `/models` returns `gpt-oss-120b`, `qwen-3.8-27b`,
   `gemma-4-31b`. Chat POST `gemma-4-31b` is 404 for min/stream/it-suffix
   bodies.
2. `qwen-3.8-27b` answers but streamed "hi" in 3.8–5.5s and 429s.
3. `gpt-oss-120b` answers structured JSON in 263ms (stream total 140ms)
   but rejects `reasoning_effort=none` (only low/medium/high).
4. Owning-boundary: pin `CEREBRAS_CHAT_MODEL` to a model whose
   chat/completions probe succeeds, not merely one that appears in
   `/models`.

## Solution

Cut over the direct Cerebras primary to `gpt-oss-120b` with
`reasoning_effort=low`. Keep `gemma-4-31b` as `CHAT_DEAD_CEREBRAS_MODEL`
and in cost ledgers. OpenRouter Cerebras spill stays
`google/gemma-4-31b-it`. Cemented in `cerebras.blackbox.ts` and
`cerebras-chat-model-not-archived.test.ts`. 10k-agent behavior: same
one-request-per-chat-call; no shared state.

## Human feedback

None recorded.

## Reusable lesson

A model id on Cerebras `/models` is not a chat-capable primary — probe
`/chat/completions` before pinning, or the 5s ratchet falls to the
waterfall again.
