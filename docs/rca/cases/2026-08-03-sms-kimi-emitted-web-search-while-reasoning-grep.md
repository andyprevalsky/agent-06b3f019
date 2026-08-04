---
id: 2026-08-03-sms-kimi-emitted-web-search-while-reasoning-grep
date: 2026-08-03
title: Kimi/OpenRouter route emitted web_search while parsed reasoning named grep
surface: back-end
component: sms-supervisor-model-routing
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: parsed Kimi/OpenRouter route response selected web_search despite reasoning that named grep
symptoms:
  - I accidentally searched the web instead of the user's contacts
  - I need to use the grep tool not web_search
  - toolsExecuted contained web_search ten times and no grep
tags:
  - sms-supervisor
  - openrouter
  - kimi
  - structured-output
  - tool-selection
  - contacts
sources:
  - memory: test run 1785811212-40967-20905 SMS supervisor contact case
repro: back-end/src/tests/blackbox/sms-supervisor.behavior.ts
status: open
---

## Problem

The corrected opt-in contact acceptance seeded `Jane Grepwell` with the opaque
address `contact-qi0ucbqe@example.com` and asked `Look in my contacts for Jane
Grepwell's email address.` OpenAI was out of credits, Anthropic was on cooldown,
and Gemini rejected the synthetic tool transcript as malformed, so Kimi handled
the rounds.

Kimi repeatedly reasoned that it needed `grep` and explicitly recognized its
own mistaken web search, but every normalized structured call was
`web_search`. After ten searches the supervisor hit its safety cap, sent the
fallback SMS, and never retrieved the seeded contact.

## Diagnosis

The natural contact name and opaque address eliminate the prior fixture
confounder and prevent a guessed value from passing. The system prompt states
that contacts live behind `grep`, the generated grep schema documents
`source: network`, and Kimi's own reasoning identifies the correct tool. The
normalized dispatch log nevertheless records `web_search` with a query on every
round.

The first observed bad boundary is therefore the parsed Kimi/OpenRouter route
response, not the grep provider or seeded data. The raw provider body was not
archived, so the evidence does not distinguish a Kimi generation defect from an
OpenRouter structured-output enforcement defect. That observability gap blocks
the exact same-client replay and model-substitution trials required before
classifying this as a model-intelligence limitation. The owned exposure is both
the missing raw boundary evidence and allowing this degraded route to serve a
complex discriminated-union tool surface without a compatibility gate.

## Solution

No fix is claimed yet. A candidate must first reproduce the exact Kimi route and
prove whether native tool transport, schema ordering, response validation, or a
different fallback model makes the emitted tool match the reasoned tool. The
unchanged real-provider contact acceptance is the required outcome check.

This incident is outside the movie-ticket budget prompt's intended behavior.
At 10,000 agents, leaving it unresolved can multiply unnecessary searches until
the per-run safety cap; any eventual routing fix must quantify provider cost,
latency, and fallback capacity.

## Human feedback

None recorded.

## Reusable lesson

When model reasoning names the correct tool but normalized dispatch repeatedly
shows another, investigate structured-output transport and fallback
compatibility before changing business logic.
