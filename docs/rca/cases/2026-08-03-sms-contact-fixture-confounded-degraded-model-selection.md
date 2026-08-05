---
id: 2026-08-03-sms-contact-fixture-confounded-degraded-model-selection
date: 2026-08-03
title: SMS contact fixture confounded degraded-model source selection
surface: back-end
component: sms-supervisor-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: provisional — sms-supervisor.behavior.ts generated contact name before degraded Kimi source selection
symptoms:
  - real-llm answers contact fact via grep expected seeded email but model treated random suffix as an agent ID
  - model reasoned that it should try contacts but searched messages documents and transactions instead of network
tags:
  - sms-supervisor
  - real-llm
  - blackbox
  - grep
  - contacts
  - provider-fallback
sources:
  - memory: test run 1785809892-75120-11322 SMS supervisor contact case
repro: back-end/src/tests/blackbox/sms-supervisor.behavior.ts
status: superseded
superseded_by: 2026-08-03-sms-kimi-emitted-web-search-while-reasoning-grep
---

## Problem

The opt-in real-LLM contact case seeded a contact named
`Jane Grepwell2wzfnq`. Kimi explicitly reasoned that the suffix looked like an
agent ID or typo, then selected `grep` over messages, documents, and
transactions. It never selected the documented contact-oriented `network`
source, so the response omitted the seeded email.

Every round used a degraded provider path: no user compute token was available,
OpenAI API credits were exhausted, Gemini rejected the accumulated tool-call
transcript as malformed, and Kimi made the observed selection decision.

## Diagnosis

The contact is isolated by test user, so a random suffix was unnecessary for
uniqueness and introduced the exact distracting shape identified in the model's
reasoning. That is a demonstrated fixture defect, but the current evidence does
not establish it as the sole cause: the degraded Kimi route also failed to use
`network` after reasoning that it should try contacts.

The raw Kimi response was not archived, and parsed-response logs stringify call
objects as `[object Object]` and truncate reasoning. The normalized dispatch
logs do capture the exact arguments, conclusively showing sources of
`messages`, `documents`, and `transactions` but never `network`. Therefore both
the classification and first bad boundary remain provisional until the
corrected fixture passes unchanged or reproduces a separate
model/tool-selection defect.

## Solution

Use the natural user-scoped name `Jane Grepwell`, seed an opaque non-derivable
`contact-<nonce>@example.com` address, and explicitly ask the supervisor to look
in contacts. The opaque expected value prevents an ungrounded model guess from
passing. The unchanged real-provider case must now prove that the email is
retrieved.

This is test-only fixture hardening with no production queries, state, privacy,
or 10,000-agent impact. The corrected case still failed: Kimi repeatedly
reasoned that it should call `grep` but emitted `web_search` ten times. That
result disproved the fixture-only diagnosis, so this case is superseded by
`2026-08-03-sms-kimi-emitted-web-search-while-reasoning-grep`.

## Human feedback

None recorded.

## Reusable lesson

Use natural fixture identifiers plus opaque expected values so real-LLM tests
cannot be misdirected by synthetic tokens or pass by guessing.
