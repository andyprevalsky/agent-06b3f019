---
id: 2026-09-12-treasury-rails-mcp-abort-timeout
date: 2026-09-12
title: treasury-rails died on unused-card settle when AgentCard tools/call AbortSignal timed out
surface: back-end
component: agentcard-org-runtime
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/agentcard/org-runtime.ts shouldRetryOrgMcpError — AbortSignal.timeout on tools/call was not treated as transient
symptoms:
  - The operation was aborted due to timeout
  - still waiting for release to settle, attempt 3
  - treasury-rails blackbox FAILED
tags:
  - treasury-rails
  - agentcard
  - org-runtime
  - timeout
  - deploy-gate
sources:
  - commit 347552664
repro: cd back-end && npx tsx src/tests/unit/agentcard-org-runtime.test.ts
status: fixed
---

## Problem

`/deploy` backend coverage failed `treasury-rails` after mint → close → settle
wait. The domain printed `(still waiting for release to settle, attempt 3)` then
`treasury-rails blackbox FAILED: The operation was aborted due to timeout`.
Coverage run `1789246160-35515-15171`; card `cmtyv2pb90180ij042kiu634j`.

## Diagnosis

`callOrgMcpTool` uses `AbortSignal.timeout(30000)`. Under coverage concurrency
the shared AgentCard sandbox stalled a `recover_funds` / `list_transfers` poll
past 30s, so `fetch` threw `TimeoutError` before any HTTP/RPC body existed.
`shouldRetryOrgMcpError` only retried rate-limit and structured
`temporarily unavailable` bodies, so the raw abort escaped to the blackbox
`main()` catch, which also did not treat AbortSignal timeouts as the existing
credential-infra skip.

Local repro: `npx tsx src/tests/unit/agentcard-org-runtime.test.ts` — a fetch
that throws `The operation was aborted due to timeout` once used to fail the
caller immediately (0 retries).

## Solution

Classify AbortSignal / `aborted due to timeout` as transient unavailable in
`org-runtime`, convert the fetch throw to `AgentCardOrgRuntimeError` 503, and
retry on the existing bounded budget. `waitForRecoverable` /
`waitForTransferReclaimed` continue the settle window across one slow poll
instead of aborting the domain. Exhausted timeouts stay 503 so the existing
treasury-rails skip still applies.

At 10k agents this keeps one stalled org MCP read from failing every in-flight
settle poll; retries stay capped at three attempts with the shared deadline.

## Human feedback

None recorded.

## Reusable lesson

A transport AbortSignal timeout on an idempotent org MCP read is the same
transient class as a structured 503 — retry it on the existing budget; do not
let the raw `TimeoutError` fail a money-settle poll.
