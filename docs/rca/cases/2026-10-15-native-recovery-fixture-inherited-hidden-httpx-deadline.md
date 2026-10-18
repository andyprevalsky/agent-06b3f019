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
  - subprocess.TimeoutExpired after 30 seconds in native recovery fixture
tags:
  - wmh
  - cancellation
  - capture
  - httpx
sources:
  - commit cce345d883547edde88b89f67b93590fbc83534c
  - commit 0118ea315c327471d761d3939a715fc4c5a1eb9c
  - plan:.context/deploy-rejected-caps-20261015/cycle4-monitor/agentsfailure.raw.private.log
repro: agents/benchmarks/wmh_validation_recovery_test.py
status: open
---

## Problem

C4 passed 109 of 110 agent domains. The native cancellation/rejoin check failed downstream at the bridge's strict pending-capture assertion and then its caller timed out. The preserved original native record shows a finalized ReadTimeout after 5.044 seconds while its capture writer was held and an independent prediction ran.

## Diagnosis

The fixture constructed an HTTPX client with its implicit five-second read deadline. Production's native-to-bridge client already uses an explicit 660-second contract, unchanged by this repair. The shorter test-only transport expired before the barrier/rejoin protocol completed; the recorded error was real, rather than evidence of a corrupted writer. The stronger unchanged owning assertion control advances only the isolated event-loop scheduler by six seconds and reproduced baseline failure in 6.950 seconds; the candidate passed in 14.530 seconds. The controlled failure reaches the attempt-count assertion rather than the exact historical ASGI line, so it establishes the shared transport boundary without relabeling those two downstream observations as identical. Native/world timestamps and request bytes are unchanged.

### C5 distinct outer-deadline failure and open attribution

C5 reached the later exhaustion branch before the original outer 30-second subprocess deadline expired. Its 34 surviving fixture files were copied as original bytes with per-member size/SHA checks before pytest retention. This differs from C4's five-second HTTPX error; the bridge cancellation trace belongs to retirement, and neither observation is relabeled as the new cause. The unchanged owning callback passes locally in 14.827 seconds, so the historical outer-timeout cause remains unresolved rather than being declared fixed from a local pass.

A separately proved inefficiency initialized the complete model-build/RAG import graph in each fresh private rejection writer merely to use archive redaction and atomic JSON publication. Those three canonical helper bodies were extracted verbatim into one lightweight module, with existing builder exports retained. A new regression in the already registered validation/recovery module exercises the actual fresh writer, checks redaction, output bytes and receipt SHA, then rejects the unrelated build import. It failed before extraction and passed afterward; baseline and candidate serialized output SHA256 both equal `adc5c9b021ea3aa4ccc02e06acbc1f7b50e3cc04f268cf8c1fbbfa8a08dd1e5e`. The existing full native callback then passes in 5.774 seconds; final two-case private verification passes in 5.620 seconds. All original assertions, 30/10/660-second deadlines, fsync/replace behavior, capture identities and retry policy stay unchanged. The extraction diff SHA256 is `a3e5285ae9baaf0032ca265412e9164ba57a687bdef4e2d548f96466098d4d13`. This proves dependency removal and local improvement, not the original timeout's cause or a full-run outcome. Normal final-source validation remains required.

## Solution

Extract the existing production constructor verbatim into one shared client factory and use it from the fixture. Production timeout, keepalive, authentication header and trust_env remain identical. Preserve the outer 30-second subprocess limit, ten-second writer barrier, all strict capture/cancellation/parallel/retirement assertions, and restore the test scheduler with try/finally. An independent existing reviewer qualified the exact revision-two diff `14bcfd756963b1bc505c939a4c8cc6f60ea79b70aa1472262853d26a824d0ac1`. The root then ran all eight owning validation/recovery cases on applied source: eight passed in 17.53 seconds with external connections denied. Production has no new per-agent query, lock, retry or connection count at 10,000 agents. This is component proof; full final-source deploy gates and fundraiser outcomes remain open.

## Human feedback

The user authorized infrastructure repairs; no WHM context or policy change is included. Hidden test transport configuration was unified with production rather than increasing the benchmark's outer timeout.

## Reusable lesson

Make integration fixtures consume the production transport constructor so hidden library defaults cannot invalidate ownership and cancellation tests.
