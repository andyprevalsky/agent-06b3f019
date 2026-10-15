---
id: 2026-10-15-native-recovery-fixture-inherited-hidden-httpx-deadline
date: 2026-10-15
title: Native recovery fixture inherited a hidden HTTPX deadline
surface: agents
component: wmh-native-transport
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: wmh_validation_recovery_native_checks constructed its own AsyncClient with an implicit five-second read deadline instead of the production native client contract
symptoms:
  - single capture_pending is True assertion failed
  - caller-cancel-invocation ReadTimeout
  - Exact native capture finalized ReadTimeout after 5044ms
tags:
  - wmh
  - cancellation
  - capture
  - httpx
sources:
  - commit 0118ea315c327471d761d3939a715fc4c5a1eb9c
  - plan:.context/deploy-rejected-caps-20261015/cycle4-monitor/agentsfailure.raw.private.log
repro: agents/benchmarks/wmh_validation_recovery_test.py
status: open
---

## Problem

C4 passed 109 of 110 agent domains. The native cancellation/rejoin check failed downstream at the bridge's strict pending-capture assertion and then its caller timed out. The preserved original native record shows a finalized ReadTimeout after 5.044 seconds while its capture writer was held and an independent prediction ran.

## Diagnosis

The fixture constructed an HTTPX client with its implicit five-second read deadline. Production's native-to-bridge client already uses an explicit 660-second contract, unchanged by this repair. The shorter test-only transport expired before the barrier/rejoin protocol completed; the recorded error was real, rather than evidence of a corrupted writer. The stronger unchanged owning assertion control advances only the isolated event-loop scheduler by six seconds and reproduced baseline failure in 6.950 seconds; the candidate passed in 14.530 seconds. The controlled failure reaches the attempt-count assertion rather than the exact historical ASGI line, so it establishes the shared transport boundary without relabeling those two downstream observations as identical. Native/world timestamps and request bytes are unchanged.

## Solution

Extract the existing production constructor verbatim into one shared client factory and use it from the fixture. Production timeout, keepalive, authentication header and trust_env remain identical. Preserve the outer 30-second subprocess limit, ten-second writer barrier, all strict capture/cancellation/parallel/retirement assertions, and restore the test scheduler with try/finally. An independent existing reviewer qualified the exact revision-two diff `14bcfd756963b1bc505c939a4c8cc6f60ea79b70aa1472262853d26a824d0ac1`. The root then ran all eight owning validation/recovery cases on applied source: eight passed in 17.53 seconds with external connections denied. Production has no new per-agent query, lock, retry or connection count at 10,000 agents. This is component proof; full final-source deploy gates and fundraiser outcomes remain open.

## Human feedback

The user authorized infrastructure repairs; no WHM context or policy change is included. Hidden test transport configuration was unified with production rather than increasing the benchmark's outer timeout.

## Reusable lesson

Make integration fixtures consume the production transport constructor so hidden library defaults cannot invalidate ownership and cancellation tests.
