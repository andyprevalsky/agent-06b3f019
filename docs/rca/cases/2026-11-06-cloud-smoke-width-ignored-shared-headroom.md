---
id: 2026-11-06-cloud-smoke-width-ignored-shared-headroom
date: 2026-11-06
title: Deploy smoke fanout exceeded current shared Fly admission headroom
surface: harness
component: deploy-test-cloud
classification: configuration-error
problem_class: concurrency-inefficiency
first_bad_boundary: campaign_width used the provider maximum without a smaller deployment admission limit
symptoms:
  - "capacity admission remained blocked for 300s"
  - "Shared-CPU capacity governor reached"
  - "all nine smoke tasks remained UNVERIFIED"
tags:
  - deploy
  - fly
  - capacity
sources:
  - PR #1708
  - commit 062824642b47563cece1c6150d83e7e485a5ef74
repro: scripts/tests/deploy-test-worker.test.py
status: open
---

## Problem

The nine-task deployment campaign passed both infrastructure canaries, then failed admission while other shared Fly workloads consumed available capacity. One observed snapshot had 144 active shared units, a 140-unit admission ceiling, and four units required per additional primary. Five jobs could not be admitted within the native 300-second window. The unchanged 5% infrastructure threshold stopped the campaign at its first qualifying failure and cancelled the four primaries still bootstrapping. No task received a scored pass.

## Diagnosis

Gate: INTRODUCED at this deploy's execution preparation: it selected the adapter's maximum width without accommodating measured shared headroom. The provider's static browser/API cap and Fly's current compute admission budget are different limits. The native capacity and stop guards behaved correctly. This is not evidence of exhausted credits or a provider outage and receives no exception.

The permanent regression shows the original adapter ignores a smaller requested width. Every selected task and the original one-run/no-retry contract remain in its command. Negative controls require invalid limits to fail before launch and prohibit a requested limit from raising the measured provider cap.

The cancelled primaries lacked sealed runtime evidence. Read-only provider pairs subsequently confirmed all four exact-source/run machines destroyed and their exact volumes detached in pending_destroy. These observations permit only isolated successor admission under the existing typed custody policy. Original incomplete evidence and financial/resource obligations remain recorded; this is not cleanup or task-pass credit.

## Solution

Accept DEPLOY_CLOUD_CONCURRENCY as a positive integer and use the minimum of that value, the selected task count and the validated provider cap. Bind the smaller width in the smoke gate's environment with its measured capacity reason. Do not change shared limits, timeouts, task inventory, assertions, the infrastructure stop threshold or provider configuration. The three focused controls and full 128-test worker suite pass; actual full native smoke validation remains required on the repaired source. Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

A static provider concurrency maximum does not establish that the shared compute fleet can admit that width now. Expose a lower-only scheduling limit without turning reduced concurrency into reduced test coverage.
