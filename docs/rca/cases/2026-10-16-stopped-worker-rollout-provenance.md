---
id: 2026-10-16-stopped-worker-rollout-provenance
date: 2026-10-16
title: Stopped same-surface workers could restart an old build after rolling deployment
surface: infra
component: worker-autoscaler-start-admission
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _scale_fleet validated a stopped candidate against its own old metadata without comparing it to the running worker build and deployment token
symptoms:
  - Same-surface rolling deployment updates only started workers
  - Stopped workers retain old image and build metadata
  - Increased demand can emit start requests for the previous deployment
tags:
  - autoscaler
  - stopped-workers
  - deployment
  - build-provenance
  - retained-worker-pool
sources:
  - PR #1518
  - commit 11e26e941eecc4f7b1fdfa01d2be1a04a34725b2
  - commit dfc976d42efea85f903b8f018ae9a9b0e9b9da15
  - commit 2018177abcd5f0e0b1577b1fc19cd298fafd4daa
  - task https://github.com/Rose-Ai-Labs/rose/pull/1518#discussion_r4290294119
repro: cd agents && venv/bin/python scripts/run_blackbox_tests.py worker
status: fixed
---

## Problem

The second fresh deployment review of credential PR #1518 found an independent
worker-reuse defect on `dfc976d42efea85f903b8f018ae9a9b0e9b9da15`.
[Review finding 4290294119](https://github.com/Rose-Ai-Labs/rose/pull/1518#discussion_r4290294119)
identified that a stopped same-surface worker omitted from rolling deployment
could later reenter the fleet with an old image, build ID and deployment token.
The defect was caught before this source was deployed; no production start or
resource mutation was performed to reproduce it.

## Diagnosis

The same-surface path intentionally rolls an explicit list of started workers,
preserving retained stopped workers. `_owned_active_pool` checks that a
candidate's active marker matches that candidate's own environment, including
its build and token. That proves internal consistency, not membership in the
deployment that is currently running. An old unmarked worker also passes the
legacy ownership branch. A matching replay surface alone cannot distinguish
these old builds from the newly rolled build.

The archive searches were `stopped worker same-surface old build autoscaler
rolling deployment` and `worker pool deployment token image ownership stopped`.
The earlier [busy-worker scale-down case](2026-10-01-autoscaler-scale-down-stopped-busy-worker-machines.md)
concerns stopping active work; its idle-only stop contract must remain intact.
This new defect is at stopped-worker start admission.

The local reproduction calls the actual `_scale_fleet`, replacing only the
external HTTP boundary. With identical registered fixture bytes, the exact
reviewed source emits start requests for an old active-marker worker, an old
unmarked worker, a wrong-build worker and a wrong-token worker. A second case
shows missing running provenance still permits a start. Both assertions fail
on the frozen reviewed runtime. The busy-live/idle-only-stop control passes.
The same three cases all pass with the repair. These are observed HTTP action
outcomes, not an inference from string matching or a native provider rollout.

## Solution

Only the stopped-start candidate list gains an additional admission condition.
When the running process has a production surface, a stopped candidate must
match its current `TEMPORAL_WORKER_BUILD_ID` and
`TEMPORAL_WORKER_DEPLOYMENT_TOKEN`. Missing current provenance permits no start.
Unrolled stopped workers remain excluded until their actual configuration is
updated through the deployment owner. No marker, image, source or retained data
is rewritten to make an old worker appear current.

Current marked and legacy peers remain eligible; the existing pinned rolling
intent remains valid. Retired, protected and foreign-generation exclusions
remain effective. Started-fleet counts, desired limits, generation queues,
idle/busy stop behavior and deployment minimums are unchanged. Removing the
single new admission block restores the prior worker function AST exactly.

The permanent worker blackbox runner registers
`autoscaler_stopped_current_build_attempt`,
`autoscaler_missing_current_provenance` and
`autoscaler_build_filter_preserves_live_drain`. The original rollback fixture
gains explicit current build/token inputs while retaining every assertion.
Full worker verification passed all 36 cases in 72.3 seconds; deployment
structural/native shell checks and all 15 retained-machine helper tests passed.
Causal before/after fixtures retain their native two-failure/three-pass results;
their standalone exact elapsed duration was not recorded.

The credential logging import was also moved into the existing import block.
The source owner's cached Ruff 0.17.0 checked the exact resulting worker bytes
through stdin and passed without ignores. Worker SHA-256:
`bc8e412c29a0acb2130ff66a9877cd5c47696d810fa0db94bab0b56885566255`.
The replay surface remains `5a946237d3f7`. Full release qualification and the
last bounded verification review remain separate from this causal source fix.
Production admission remains held for the required initial worker overlap;
this repair does not supply additional Machine objects or authorize reuse of
protected resources.

## Final release qualification and reuse constraint

The complete shipping runtime was frozen at
`23d273bb9e4819a7b84d67f1365303d8ed0480a7`, surface `5a946237d3f7`.
It includes the stopped-start repair plus the reviewed default reuse-only guard
`4506414f051301be4e239df5df1e1789834a0042`. The guard measures retained
same-app candidates and refuses a positive shortfall before any clone; builds
are local-only. Identical owning fixtures fail on the earlier source's eight
clone requests and pass for no-spare, partial-four-spare and second-update-failure
cases with zero creates, unchanged IDs/data and no pointer flip. Legacy
fresh-provision fixture lanes opt in explicitly; production defaults to reuse.

The final full qualification passed 110 agent blackbox domains, 184 cache tests,
134 unit tests at 83% coverage, mandatory TypeScript and structural checks,
46 deployment structural gates, five cold seeds (159MB maximum against 228MB),
all three live probes, all 14 unchanged selected benchmark tasks, eight semantic
UI cases, the real E2B smoke and five isolated latency tests with 20 samples.
The four path p50s were 924/2403/795/639ms, smoothness 1.000 throughout.
All five payment lifecycles settled. Exact owned test processes, listeners and
isolated databases were retired, preserving shared Postgres. The original
specific auth-decline failure remains Overridden for PR1518, never PASS.

Qualification is not production activation. One app-only read at
2026-10-16T04:27:59Z positively found eight started production Machines and
zero stopped/certified retained candidates, all on source
`6ef22cc55811444f1524fb9faf22f6e97600410e`, surface `f5734e638fc8`.
The earlier 03:30 source-queue observation found one real parent and two real
children; those time-stamped observations are not a continuous liveness claim.
No additional IDs, quota change or interruption of these workloads is authorized.

Source-only inspection of that exact old worker rejects general application
pause as a noninterrupting drain: its pause signal cancels active browser work
and closes pending auth continuation. The old shutdown also has a five-minute
cutoff. These are source feasibility limits, not a locally reproduced new
production incident or a claim that every live activity would fail. No workflow
control was sent. A separate durable-root-intent/caller proposal remains frozen
and unintegrated; its staged admission, topology bootstrap and original-eight
activation controller are not implemented or qualified. The required safe
existing-ID cutover remains open; no merge or production success is claimed.

## Human feedback

None recorded for this finding. The existing request is to finish the
credential release; the specific auth-decline exception does not waive worker
correctness, minimum capacity, activation or drain checks.

## Reusable lesson

Compare a stopped resource's deployment provenance with the running owner before allowing it back into service.
