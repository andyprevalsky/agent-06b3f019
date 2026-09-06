---
id: 2026-09-06-semantic-poller-rejected-retryable-hub-warming
date: 2026-09-06
title: Semantic Temporal polling treated a retryable Hub-warming response as terminal
surface: harness
component: semantic-lifecycle-polling
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/tests-e2e/helpers.ts waitForTemporalWorkflow retried a transient agent-visibility miss only when its HTTP status was 404
symptoms:
  - 'Temporal-start check failed: 503 {"temporal_workflow_id":null,"status":null,"status_message":null}'
  - agent_plan sample 1 missed milestones
  - agent_execute sample 1 missed milestones
tags:
  - production-semantic
  - benchmark-hub
  - retry-contract
  - temporal-start
sources:
  - PR #1266
  - commit 3e3ca14224d44d30a852dc926f5444e0ca04675f
  - agent 9a68e637-1af5-45e0-84ca-6c3f09fd7f3a
  - agent 2c3afba2-3406-46a6-9966-1d941467320b
repro: front-end/src/tests/blackbox/semantic-temporal-workflow-poll.blackbox.ts
status: fixed
---

## Problem

The production semantic workflow passed its direct-answer and web-search
lifecycle ratchets, then failed every measured `agent_plan` and `agent_execute`
sample at the first Temporal-start read. GitHub workflow run `34005870361`
recorded the same terminal failure for all ten samples, including agents
`9a68e637-1af5-45e0-84ca-6c3f09fd7f3a` and
`2c3afba2-3406-46a6-9966-1d941467320b`: `Temporal-start check failed: 503
{"temporal_workflow_id":null,"status":null,"status_message":null}`.

The backend response body was `Benchmark Hub archive index is warming; retry
shortly`. Production Prisma inspection showed the newly created rows had already
persisted their Temporal workflow IDs before semantic teardown soft-deleted them,
so the failure was the observer terminating on the transient read, not a worker
startup failure.

## Diagnosis

Critical path:

`semantic browser emits a new agent id -> waitForTemporalWorkflow GETs the agent
before the live row is visible -> the archive fallback reports its documented
warming state as HTTP 503 -> waitForTemporalWorkflow throws -> teardown deletes
the healthy agent -> the lifecycle sample records a missed milestone`.

The first bad boundary was `waitForTemporalWorkflow`: its error condition retried
network failures and HTTP 404, but threw for every other non-success response.
PR #1266 deliberately changed an indeterminate legacy-archive miss from a false
404 to a retryable 503, while this semantic consumer retained the old one-status
contract. The frontend blackbox was run unchanged against detached pre-fix commit
`3e3ca1422` and failed in 18 ms with `promise rejected ... instead of resolving`,
caused by the same `Temporal-start check failed: 503` error. Its mocked second
response contained the already-visible workflow ID, proving that the premature
throw—not Temporal startup—prevented success.

The deepest owned cause was a logical inconsistency in the cross-layer harness
contract: transient agent visibility was encoded as the literal status 404 in
one consumer, and no behavioral test replayed the backend's retryable 503
response followed by a successful live read. Archive searches for the literal
error and for production semantic visibility failures found the related
`2026-09-06-background-hub-child-index-sync-io-starved-backend` case and the
older `2026-07-18-poll-without-per-request-timeout-burns-whole-budget` case.
This is a relative of both, not a recurrence: their first-bad boundaries stayed
fixed, while the newly explicit response contract exposed a separate test-client
assumption.

## Solution

`waitForTemporalWorkflow` now classifies HTTP 404 and HTTP 503 as retryable
visibility responses and keeps every other non-success response fatal. The
per-request timeout, overall caller deadline, 150 ms poll interval, and five-
second lifecycle ratchet are unchanged. This covers both an ordinary live-row
race and a warming legacy archive index for every semantic agent path without
hiding authentication failures or unexpected backend errors.

The checked-in frontend blackbox replays `503 -> 200 with temporal_workflow_id`
and separately pins that HTTP 500 still rejects after one request. The same
command that failed on the detached baseline passed both tests after the fix:

```bash
cd front-end && ./node_modules/.bin/vitest run \
  src/tests/blackbox/semantic-temporal-workflow-poll.blackbox.ts --maxWorkers=1
```

This helper is test-only and does not run in the 10,000-agent production path.
The canonical lifecycle ratchet sets `SEMANTIC_WORKERS=1` and executes its
samples sequentially, so the 150 ms cadence cannot fan out into 10,000 pollers;
the fix adds no shared channel, accumulated state, scan, or background poller.
It deliberately does not claim that arbitrary 10,000-caller polling at this
cadence would be safe. A guard is appropriate here because the backend and
Playwright harness cannot share a runtime module, and deleting either the
authoritative Temporal-start read or the backend's fail-closed warming state
would weaken the contract.

## Human feedback

None recorded.

## Reusable lesson

Whenever an API introduces an explicit retryable status, replay it through every bounded polling consumer and pin both retry and fail-fast behavior.
