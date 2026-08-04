---
id: 2026-08-03-sms-real-llm-fixtures-diverged-from-persisted-input-contract
date: 2026-08-03
title: SMS media fixtures diverged from persisted attachment contract
surface: back-end
component: sms-supervisor-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/sms-supervisor.media.behavior.ts persisted-turn assertions
symptoms:
  - photo attachment persisted user turn contained one attachment marker instead of photo(s) attached
  - voice note persisted user turn contained one attachment marker instead of the derived transcript
tags:
  - sms-supervisor
  - real-llm
  - blackbox
  - attachments
sources:
  - memory: test run 1785809892-75120-11322 SMS supervisor opt-in cases
repro: back-end/src/tests/blackbox/sms-supervisor.blackbox.ts
status: open
---

## Problem

Two opt-in real-LLM media cases failed while their underlying product paths
behaved differently from the test assumptions. The photo model correctly
answered `Red`, and the voice-note pipeline logged an
88-character transcription before the model correctly answered `Paris`.
Nevertheless, both cases failed their persisted-user-turn assertion because the
session contained the webhook's canonical `[1 attachment(s)]` marker rather
than test-invented derived text.

## Diagnosis

`sms-webhook/service.ts` persists inbound SMS synchronously as the raw body plus
an attachment-count marker before asynchronous media processing. The supervisor
then downloads images or transcribes audio and supplies that richer content to
the current LLM turn. It does not rewrite the already-persisted user turn. The
media tests asserted a different persistence contract even though their
reply-level assertions proved image understanding and transcription worked.

The first bad boundary is conclusively the acceptance assertion: the processor
and model succeeded, while the assertion contradicted the session store's
deterministic canonical-input contract.

## Solution

Assert exactly one persisted user turn with the exact canonical
body-plus-attachment-marker content in both media cases, while retaining `Red`
and `Paris` reply assertions as the end-to-end proof that the richer
image/transcript content reached the model.

These are test-only assertion corrections. They change no production behavior,
queries, state, privacy, or 10,000-agent characteristics. Status remains open
until the same real-LLM domain passes unchanged.

## Human feedback

None recorded.

## Reusable lesson

Real-LLM fixtures should use natural user data and assert each pipeline boundary's
actual contract instead of requiring derived runtime content to be persisted.
