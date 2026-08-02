---
id: 2026-06-26-stalled-direct-compute-token-rotation-loop
date: 2026-06-26
title: Stalled direct compute tokens were rotated indefinitely inside a budget too small for the fallback waterfall
surface: agents
component: rose-client
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: agents/providers/rose/client.py — direct compute-token rotation had no cap and TTFT stalls did not mark the token unhealthy
symptoms:
  - LLM calls stall with no time-to-first-token and never reach the provider waterfall
  - agent activity times out before the direct-token plus fallback sequence can complete
  - the same stalled direct-auth token is retried on the immediately following call
tags:
  - rose
  - compute-token
  - claude-auth
  - ttft
  - retry-budget
sources:
  - PR #663
repro: agents/tests/blackbox/rose.blackbox.py
status: fixed
---

## Problem

Agent LLM calls hung on the direct compute-token (claudeAuth) path with no
first token arriving, and the overall activity budget expired before the request
could rotate off the bad token and complete through the provider waterfall — so
a stalled token turned into a failed agent step instead of a slower one.

## Diagnosis

Two compounding causes. First, the direct-token path rotated through tokens
without a cap, so a systemic stall consumed the whole budget in rotations that
could never succeed. Second, the client/activity budget was sized for a single
happy-path completion, not for "direct-token attempt(s) then full fallback
waterfall" — meaning the escape hatch existed but there was never enough time
left to use it. A TTFT stall also left no mark on the token, so the very next
call selected the same stalled credential again.

## Solution

Capped direct compute-token rotations at two before falling through to the
provider waterfall; marked direct-auth tokens rate-limited for 10 minutes when
they stall on TTFT so subsequent calls skip them; and increased the Rose
client/activity budget so the full direct-plus-fallback sequence fits inside it.
A regression test was added on the Rose blackbox path. The same PR updated the
RCA guidance to require locally reconstructing a failing LLM/provider call rather
than reasoning about it from logs alone.

## Human feedback

The RCA methodology was amended in this PR to require local reconstruction of the
failing LLM/provider call — i.e. a theory about a provider stall is not an
acceptable deliverable without reproducing the call locally.

## Reusable lesson

A retry budget must be large enough to contain every fallback tier it enables,
and a stall must mark its credential unhealthy — otherwise retries consume the
budget that the fallback needed.
