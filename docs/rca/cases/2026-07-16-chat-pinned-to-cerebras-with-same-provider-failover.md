---
id: 2026-07-16-chat-pinned-to-cerebras-with-same-provider-failover
date: 2026-07-16
title: Synchronous chat pinned to one Cerebras model with a same-provider "failover" went silent on a stall
surface: back-end
component: chat-route
classification: our-bug
problem_class: other
first_bad_boundary: "back-end synchronous chat generator — `directCerebrasFailover` retried the same provider, and the message route swallowed the resulting failure"
symptoms:
  - "the message route returns 201 and then the assistant never replies"
  - a Cerebras stall kills the whole chat turn with no error surfaced to the user
  - "prod agent 6d19b666 chat silence"
tags:
  - cerebras
  - chat
  - failover
  - silent-failure
  - openrouter-waterfall
sources:
  - PR #780
repro: chat-cerebras-fallback.blackbox.ts
status: fixed
---

## Problem

Synchronous chat produced no assistant reply at all: the message route answered
`201` and the conversation then sat in silence. Observed on prod agent
`6d19b666`, where a Cerebras stall killed the turn.

## Diagnosis

Chat was pinned to GLM-4.7 on Cerebras, and its only recovery path,
`directCerebrasFailover`, retried _the same provider_ — so a provider-level stall
had no escape and killed the entire turn. The real multi-provider OpenRouter
waterfall was never reached. Compounding it, the message route swallowed the
resulting failure instead of persisting an error, converting a provider outage
into indistinguishable silence for the user, and the terminal-state reactivation
guard did not cover `OUT_OF_CREDITS` / `COST_LIMIT_REACHED`, so those states could
leave the agent out of chat mode. The deeper cause: a "failover" that stays inside
the failing dependency is not a failover, and a route that returns success before
the work succeeds cannot report the loss.

## Solution

A pre-content Cerebras stall now falls through to the real multi-provider
OpenRouter waterfall, and `directCerebrasFailover` was deleted rather than
patched. The message route now fails loud by persisting an assistant error
message, and the terminal-state reactivation guard was widened to cover
`OUT_OF_CREDITS` and `COST_LIMIT_REACHED`. Cemented as
`chat-cerebras-fallback.blackbox.ts` in the deploy blackbox suite, failing before
the fix and passing after. A later change (PR #832) bounded the latency of that
fallthrough by racing the stalled stream against alternatives.

## Human feedback

The RCA methodology was amended in this PR to add Step 6a — "prefer the fix that
shrinks the subsystem" (delete → unify → guard). Consistent with that rule, the
same-provider failover path was deleted instead of being extended with another
retry layer.

## Reusable lesson

A fallback that retries the same provider is not a fallback, and a route that
returns 201 before the generation succeeds turns any provider stall into
unreportable silence — fall through to a different provider and persist a visible
error.
