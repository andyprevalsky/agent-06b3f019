---
id: 2026-10-15-sms-reaction-selection-ignored-inbound-cancellation
date: 2026-10-15
title: Reaction selection ignored inbound cancellation during retries and before delivery
surface: back-end
component: sms-supervisor
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: inboundReaction.ts omitted the inbound abort signal from callWithRetries and did not recheck it before native delivery
symptoms:
  - cancelled reaction selection retries three times
  - successful selection sends a native WhatsApp reaction after inbound cancellation
tags:
  - sms
  - whatsapp
  - cancellation
  - retries
sources:
  - PR #1520 review comment4277658906
  - task .context/deploy-review-reaction-before.log
  - task .context/deploy-review-reaction-after.log
repro: cd back-end && node --experimental-test-module-mocks --import tsx src/tests/unit/sms-supervisor-reaction.test.ts
status: fixed
---

## Problem

A cancelled/superseded inbound still ran reaction-selection retries. If selection
succeeded while cancellation arrived, the existing retry helper returned success
without another signal check and the native WhatsApp reaction could still send.

## Diagnosis

Path: handler config.abortSignal -> reaction selection -> existing retry helper
-> dispatch wrapper -> native WhatsApp send or silent SMS no-op. Handler already
passes its entire config. The reaction's narrower type and retry options dropped
the signal; after success there was also no pre-delivery cancellation check.
Offline execution of the actual functions with fake LLM/transport boundaries
records 3 selection attempts before/1 after for abort+throw, and 1 native send
before/0 after for abort+success. This is causal isolated proof, not a production
send or a completed permanent owning-suite/deploy run.

Archive searches: `sms supervisor cancelled reaction retries abort signal` and
`superseded inbound cancellation retry callWithRetries`. The July13 inbound
persistence case was read and has a different first bad boundary (record write
ordering), so appending this retry/delivery bug there would misstate recurrence.
No existing owning cancellation case matched. The existing retry helper is the
canonical mechanism: it already checks the supplied signal before attempts and
after failures. The dispatch wrapper preserves a failed first react_to_message
attempt on cancellation. No new cancellation architecture is needed.

## Solution

The implementation adds optional abortSignal and passes it to callWithRetries, then rechecks
after awaited selection and before transport. Keep the first tool attempt,
existing SMS success/skipped:true/delivered:false behavior and scheduled skip.
Do not cancel already-issued provider requests or alter generic retry policy.
The existing unit suite adds already-aborted, abort+throw and
abort+success cases with real retry/dispatch code, zero transport/persistence and
first failed tool trace; all previous SMS success/order assertions remain.

The unchanged owning unit command failed before the implementation: the already-aborted request still selected once instead of zero times. After the implementation it passes all three cancellation cases and the full existing first-reaction, silent SMS, native WhatsApp, quote and substantive-reply checks. Real retry/dispatch helpers remain in use; only model and transport boundaries are fixtures. Before/after logs are retained under `.context/deploy-review-reaction-{before,after}.log`. Full deployment gates remain mandatory and are not claimed complete here.

## Human feedback

The parent delegated read-only drafts while immutable Group4 runs, required the
post-success cancellation boundary and forbade tracked changes, DB/provider
requests or new prompt/schema/architecture. The user authorized deployment.

## Reusable lesson

Pass the owner's cancellation signal through retries and recheck it after awaited preparation before initiating a side effect.
