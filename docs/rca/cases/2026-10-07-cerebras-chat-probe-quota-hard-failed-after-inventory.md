---
id: 2026-10-07-cerebras-chat-probe-quota-hard-failed-after-inventory
date: 2026-10-07
title: Cerebras live chat probe treated shared-org 402 quota as an archived-model failure after inventory already passed
surface: back-end
component: cerebras-blackbox
classification: test-bug
problem_class: other
first_bad_boundary: back-end/src/tests/blackbox/cerebras.blackbox.ts retried only HTTP 429, then required 2xx from the live chat probe even after /models listed qwen-3.8-27b and omitted the archived GLM id
symptoms:
  - "chat model probe must succeed: HTTP 402"
  - "payment_required"
  - "backend-coverage-blackbox exit=1 cerebras"
tags:
  - cerebras
  - deploy-gate
  - quota-skip
  - inventory
sources:
  - PR #1436
  - task backend coverage 20261007-202927-10987
repro: back-end/src/tests/blackbox/cerebras.blackbox.ts
status: fixed
---

## Problem

Deploy run `20261007-202927-10987` failed backend coverage at the live Cerebras
chat probe. Isolated `cerebras,data-google-sources,fast-cache` with
concurrency 1 still failed only cerebras: `/models` was reachable, the
configured chat model was listed, the archived GLM id was absent, and the
mocked exclusive-route case passed. The live POST then returned HTTP 402
`payment_required` / `quota` on the shared production key. The probe retried
only 429, then asserted 2xx.

## Diagnosis

The live probe has two jobs: prove the configured chat model is not archived,
and ratchets a successful completion under 5s. Inventory already answered the
archived-model question. A 402 on the same org key used by Render is the
shared Cerebras quota state already classified in
`2026-07-16-chat-pinned-to-cerebras-with-no-non-cerebras-failover`, not a
missing model. Treating that funding state as a hard coverage failure blocked
deploy after the contract that matters had passed.

Local isolated replay after the skip (`PATH=/tmp/bin` runner, concurrency 1):
inventory still asserted, five 402 retries, then
`SKIP live Cerebras chat probe: quota/payment_required after inventory ok (402)`.
Domain PASS in 15498ms.

## Solution

Retry 402 / `payment_required` the same way as 429. After retries, if the
status is still 402 or the body still says quota, skip the latency ratchet
and keep the inventory asserts. Any other non-2xx, including 404 archived,
still fails.

## Human feedback

Do not skip inventory. A missing or reappeared model remains a hard failure.
Quota skip is only legal after those asserts.

## Reusable lesson

A live inventory probe and a live completion ratchet are different contracts.
Shared-org quota can fail the completion without invalidating the catalog
assert. Skip only the ratchet, and only after the catalog proof.
