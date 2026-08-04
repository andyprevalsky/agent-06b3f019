---
id: 2026-07-20-transient-proxy-init-failure-classified-fatal
date: 2026-07-20
title: A transient Kernel proxy-init 400 was classified fatal, killing the browser session instead of retrying
surface: agents
component: browser-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browser session initialization — every 4xx from Kernel proxy init was treated as permanent, including "Proxy is marked unavailable"
symptoms:
  - "400 Proxy is marked unavailable"
  - "Browser automation failed" ends the run on first proxy-init error
tags:
  - browser-agent
  - kernel
  - proxy
  - retry-classification
  - transient-error
sources:
  - PR #816
repro: agents browser blackbox (proxy-init retry coverage)
status: fixed
---

## Problem

During RCA of prod agent `53feac08`, browser sessions died at initialization with
Kernel returning `400 Proxy is marked unavailable`, which the agent surfaced as a
fatal "Browser automation failed" — ending the task on a condition that clears on
its own within seconds.

## Diagnosis

Error classification collapsed all 4xx responses from proxy initialization into
"permanent failure". But `400 Proxy is marked unavailable` is a _capacity_ signal
about one proxy, not a statement that the request is invalid; the correct response is
to acquire a fresh proxy and try again. Because the classifier keyed on status class
rather than on meaning, a recoverable, self-clearing condition became a terminal
agent failure — and the same blind spot covered 5xx responses.

## Solution

`400 Proxy is marked unavailable` and all 5xx responses from proxy init are now
classified retryable, with a bounded retry (4 attempts, 5s apart, fresh proxy each
time). Genuine bad 4xx (malformed/unauthorized requests) stays fatal, so the change
does not mask real errors. Bounded retries keep the cost predictable rather than
introducing an unbounded loop.

## Human feedback

None recorded.

## Reusable lesson

Classify retryability by what the error _means_, not by its status class — a 400 that
reports transient capacity must acquire a fresh resource and retry within a bounded
budget.
