---
id: 2026-08-03-sms-purchase-request-never-delegated-to-start-agent
date: 2026-08-03
title: SMS purchase request searched inline instead of delegating to an agent
surface: back-end
component: sms-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: providers/rose/transforms.ts::extractToolsFromResponseFormat — the supervisor never reached the intended model, so tool selection was made by an unintended fallback
symptoms:
  - Exact Odyssey IMAX purchase request executed six web searches and two grep calls without start_new_agent
  - real-llm clear purchase request spawns agent timed out after 90000ms
  - waterfall.done claude_auth_failed=RoseInvalidRequest on every supervisor round
tags:
  - sms-supervisor
  - start-new-agent
  - purchase
  - delegation
  - tool-selection
sources:
  - memory: test run 1785809892-75120-11322 exact movie-ticket acceptance
  - memory: blackbox run 1785862244-54900-27333 fails, 1785863202-60925-4874 passes
repro: back-end/src/tests/blackbox/sms-supervisor.behavior.ts (testRealLlm_purchaseRequestSpawnsAgent)
status: fixed
---

## Problem

A clear SMS purchase request never called `start_new_agent`. The supervisor ran
`web_search` repeatedly, then asked the user for payment details, so the
real-LLM acceptance timed out after 90 seconds waiting for a persisted agent
row. Reproduced locally on `get me the best lip balm from amazon`:
`toolsExecuted=["web_search","send_user_message"]`, 71s, no agent.

## Diagnosis

The first two hypotheses were both wrong, and both were prompt-shaped:

1. A `start_new_agent` description on the response schema — the unchanged
   acceptance still ran eight `web_search` calls and created no agent.
2. An explicit `# Delegation Boundary` rule in the SMS surface prompt — rejected
   by the human as overfitting to one captured request before it shipped.

The mechanical cause was upstream of the prompt entirely. Every supervisor round
carrying a Claude token was rejected by Anthropic and fell through to the paid
waterfall, so the tool-selection decisions blamed on "the model" were made by an
unintended fallback model, never by the model the request was addressed to. See
[2026-08-04-sms-claudeauth-rejected-by-anthropic-schema-limits](2026-08-04-sms-claudeauth-rejected-by-anthropic-schema-limits.md)
for that chain (`enum` vs `const` discriminator → legacy single-schema path → 27
union parameters over Anthropic's limit of 16).

The local acceptance had also been drawing no compute token at all, because
blackbox users are provisioned fresh, so it exercised the waterfall even before
the rejection mattered.

## Solution

No SMS prompt or schema text was added. Fixing the Rose provider layer so the
claudeAuth request is accepted made the same unchanged request delegate:
`toolsExecuted=["start_new_agent","send_user_message"]` on
`actual_model=claude-sonnet-5-claude`, in ~8s instead of a 90s timeout, with the
goal correctly naming the purchase.

`back-end/scripts/run-blackbox-tests.sh` now seeds the local Claude Code
credential the same way it seeds `gpt_code` and marks it poolable, so
freshly-provisioned real-LLM test users exercise the production-shaped direct
path instead of silently degrading to the waterfall. Without a keychain (CI,
Linux) the previous behavior is unchanged.

## Human feedback

The human rejected the delegation prompt and schema text as overfitting: the
supervisor should get awareness of what the budget means, not instructions
tailored to one captured request. That rejection is what forced the search for a
mechanical cause instead of more prompt text.

## Reusable lesson

Before concluding "the model chose badly", prove which model actually served the
call — a silent provider fall-through invalidates every downstream behavioral
conclusion.
