---
id: 2026-10-25-chatgpt-oauth-backend-rejects-cache-breakpoints-gpt-route-cross-sequence-reuse-is-opportunistic
date: 2026-10-25
title: GPT-route single-shot call sites read 0 cache because ChatGPT backend cross-sequence reuse is opportunistic, not because breakpoints are missing (the backend rejects them)
surface: agents
component: rose-client
classification: third-party-failure
problem_class: other
first_bad_boundary: ChatGPT/Codex OAuth backend prefix cache (provider-side routing); Rose agents/providers/rose/gpt_auth.py gpt_auth_complete builds a correct, byte-stable, breakpoint-free body
symptoms:
  - "gpt-6-sol-gpt planner cache_read=0 cache_write=0"
  - "dag_reasoning cache_read=0 cache_write=0 gpt-6-sol-gpt"
  - "spawn-sub-agents cache ratchet 20.3% below 25% floor on GPT route"
  - "rose.transport.codex.error status=400 with prompt_cache_breakpoint"
  - "RoseInvalidRequest Codex 400"
tags:
  - prompt-caching
  - gpt-route
  - codex
  - chatgpt-oauth
  - cache-breakpoints
  - cache-ratchet
sources:
  - agent 2a77030f-b4c9-4a97-8829-c0c36bed4318
  - agent d373168f
  - fleet run 20261023-023933-27300
  - fleet run 20261023-071845-27529
  - memory:gpt56-explicit-cache-breakpoints
repro: agents/tests/blackbox/rose.blackbox.py::test_chatgpt_oauth_route_never_sends_cache_breakpoints_and_keeps_its_cache_session
status: wontfix
---

## Problem

The R3f golden-reference cache ratchet (share = read/(read+write+uncached)) failed
spawn-sub-agents run 2a77030f on the leased-GPT route (gpt-6-sol-gpt) at 20.3%
against a 25% floor. That run's worker `llm.cache` events show planner 13,178,
dag_reasoning 7,209, verifier_execute 2,783 and one dag_param_populator 11,826
prompt tokens with cache_read=0 and cache_write=0. Only the second plan_loop call
read anything (8,704). Claude-routed runs of the same task scored 39.0% and 55.1%.
The suspected cause was that GPT-5.6+ caches only at explicit breakpoints and these
call sites did not get them on the GPT path.

## Diagnosis

Live probes went through the real `RoseClient` with a leased GPT token
(`fetch_compute_token_activity(token_type="gpt")`).

1. With no breakpoints, the ChatGPT backend caches growing prefixes. For
   planner- and dag_reasoning-shaped requests, call 2 read 10,496 of ~11.2k tokens.
   The backend reports `cache_write_tokens: 0` on every call, including the calls
   whose prefix is later read. So write=0 is how it reports, not proof that nothing
   was written.
2. Sending `prompt_cache_breakpoint` to this backend fails. Through
   `_attempt_with_token`, the same body returned 200 without breakpoints and
   `RoseInvalidRequest: Codex 400` with them. Through `RoseClient`, the 400 made
   the call fall through to Foundry. So `gpt_auth_complete` correctly omits
   `cache_breakpoints=True`, and the proposed fix would break the route.
3. Cross-sequence reuse is opportunistic. Across 7 GPT-route spawn-sub-agents
   records, the same call sites do hit sometimes: planner read 13,056 in 2 of 7,
   dag_param_populator 4,864 in several, dag_reasoning 5,504 once, verifier 1,920
   once, and plan_loop call 1 read 8,704 across agents. Their prefixes are byte-stable.
   Their zero reads come from being the first call with that prefix in the
   sequence, plus provider routing.
4. The `prompt_cache_key` lane is not the cause. With identical static prefixes
   and 7 agents per mode, the current per-sequence keys gave 5 of 6 follower agents
   a read (5,120). A shared key across agents gave 0 of 6. The July per-sequence
   design (case 2026-07-23-provider-cache-affinity-not-scoped-to-one-sequence) stays.
5. Claude parity: `claude_auth.py` also drops `context_tools`, so planner tool
   prefixes are treated the same on both routes. The remaining gap is that Anthropic's
   org prefix cache serves a matching prefix every time, while the ChatGPT backend
   serves cross-sequence matches only some of the time.

## Solution

No change to provider behaviour. Rose's GPT request was already correct. The
checked-in regression builds the planner, dag_reasoning, verifier_execute and
dag_param_populator bodies on the ChatGPT OAuth route with caller `cache_control`
markers on a GPT-5.6+ model. It asserts no `prompt_cache_breakpoint`, a stable
`prompt_cache_key` and instructions, and a byte-stable input prefix across two calls.
Applying the proposed `cache_breakpoints=True` to `gpt_auth_complete` makes it fail.
A comment at the call site records the 400. 10k-agent behaviour is unchanged:
per-sequence lanes stay, with no shared key or fan-in.

Golden refs: codex-rs keys `prompt_cache_key` per conversation, the same as Rose's
per-sequence lane, and sends no breakpoint field. Claude Code puts `cache_control`
only on Anthropic routes, where those markers are supported.

Open follow-up for the cache-ratchet owner (R3f): on the GPT route a
deterministic per-run floor is measuring provider-opportunistic cross-sequence
reuse. Do not fix it by adding breakpoints or a shared key. Whether to change the
floor or add a route-aware gate needs a decision by that owner.

## Human feedback

None recorded.

## Reusable lesson

Before adding provider cache hints, live-probe that exact backend with the real
client: the ChatGPT OAuth route rejects `prompt_cache_breakpoint` (400), always
reports zero cache writes, and serves cross-sequence prefix hits only opportunistically.
