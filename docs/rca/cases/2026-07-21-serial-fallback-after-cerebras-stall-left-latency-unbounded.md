---
id: 2026-07-21-serial-fallback-after-cerebras-stall-left-latency-unbounded
date: 2026-07-21
title: The post-stall Cerebras fallback ran serially, so a stalled stream added its whole stall to chat latency
surface: back-end
component: chat-generator
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end chat generator fallback — a stalled direct Cerebras stream was abandoned and then retried sequentially instead of raced"
symptoms:
  - chat replies are very slow whenever the direct Cerebras stream stalls
  - the stalled provider's full stall time elapses before any fallback produces content
  - an aborted waterfall advances to another model instead of stopping
tags:
  - cerebras
  - chat
  - latency-hedge
  - openrouter
  - fallback
sources:
  - PR #832
repro: none-recorded
status: fixed
---

## Problem

After the earlier fix that let a stalled direct Cerebras stream fall through to the
provider waterfall (PR #780), the fallthrough was still _serial_: the user paid the
stalled stream's entire stall before any alternative produced content, so chat
latency was unbounded by the slowest provider. The source records the post-fix
numbers rather than a pre-fix measurement: the concurrent OpenRouter fallback race
returned 16/16 valid structured completions, and the semantic lifecycle suite went
12/12 with every sample under 5s (web-search max 4.418s).

## Diagnosis

Recovery was sequenced instead of hedged. Detecting a stall and _then_ starting the
next attempt makes total latency the sum of every attempt, which is the wrong shape
for a stall whose duration is unknown and unbounded. Two adjacent defects made it
worse: the minimal reasoning-effort setting was not propagated through generator
fallbacks (so a fallback answered with different parameters than the primary), and an
aborted waterfall kept advancing to another model instead of stopping, wasting work
on a request nobody was waiting for anymore.

## Solution

Once the latency hedge arms, race the stalled direct Cerebras stream against
same-model OpenRouter and the existing generic waterfall, taking the first winner and
cancelling the losers — total latency is now bounded by the hedge, not by the stall.
Minimal reasoning effort is propagated through generator fallbacks, and aborted
waterfalls no longer advance to another model. Regression coverage was added for both
race winners, loser cancellation, and the provider-route contracts.

## Human feedback

Per explicit user instruction the Claude Code agent smoke task was omitted from this
deploy, because its earlier failure was an external Anthropic credit condition rather
than a regression from this change.

## Reusable lesson

Bound stall recovery by racing alternatives behind a latency hedge rather than
detect-then-retry — serial fallbacks make user-visible latency the sum of every
attempt.
