---
id: 2026-07-29-browser-context-structural-test-followed-pre-refactor-file-boundary
date: 2026-07-29
title: Browser-context structural test searched session.ts after profile policy moved to profileBinding.ts
surface: harness
component: browser-context-structural-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browser-context-nullability.test.ts — benchmark profile assertions searched only the pre-refactor session.ts boundary
symptoms:
  - Steel provider must support benchmark anon mode for fresh per-agent profiles
  - npm run test:structural fails while BENCHMARK_ANON_STEEL_PROFILE support remains implemented
  - browser-context-nullability.test.ts cannot find benchmarkAnonProfilesByAgent in session.ts
  - test_status_polled_over_data_plane_proxy_not_ssh cannot find validated log append in refresh_bench_log
  - refresh_bench_log_checked command not found in the isolated bounds fixture
tags:
  - structural-test
  - steel
  - browser-context
  - stale-file-boundary
  - benchmark-profile
sources:
  - PR #1299
  - commit 701af91fdef0ffd05802041f8db20ad36aa78698
  - commit 36131c535e45cabdb2089348f964cabf7070d6a5
repro: back-end/src/tests/structural/browser-context-nullability.test.ts
status: fixed
---

## Problem

The full structural suite failed with `Steel provider must support benchmark
anon mode for fresh per-agent profiles`. The provider still supported
`BENCHMARK_ANON_STEEL_PROFILE`, kept per-agent profiles, and prevented those
profiles from overwriting `BrowserContext.contextId`; those invariants no longer
lived entirely in `session.ts`.

## Diagnosis

Commit `36131c535e45cabdb2089348f964cabf7070d6a5` extracted Steel profile policy
from `session.ts` into `profileBinding.ts`. The structural test continued
searching only `session.ts` for the environment flag and per-agent map, so a
valid implementation refactor appeared to be a product regression. The first
bad boundary was the test's stale ownership model, not the runtime provider.

## Solution

Make each structural assertion inspect the file that owns its invariant:
`profileBinding.ts` for benchmark mode, per-agent state, and persistence policy;
`session.ts` for applying that policy before writing the browser context. Remove
the file-wide lint suppression while touching the test.

## September 12 recurrence: delegated log refresh

The full controller gate on `701af91fdef` passed all sixteen multi-workstream
scenarios and eighteen backstop tests, then failed one of 122 focused checks:
`test_status_polled_over_data_plane_proxy_not_ssh` still expected the validated
append inside `refresh_bench_log`. Commit `49af4b098` had moved that existing
implementation into `refresh_bench_log_checked`, leaving a wrapper that records
failed-read metadata and returns the original status. The test inspected the
old lexical boundary rather than the helper that still owns byte validation.

Archive searches were `test_status_polled_over_data_plane_proxy_not_ssh
refresh_bench_log` (no exact hit) and `structural test wrapper delegated helper
assertion stale` (this case). This is a recurrence of the structural-test
boundary mismatch. The earlier case repaired its browser-profile callers; this
new extraction did not update every test consumer. The critical path is source
extraction → wrapper-only text → append assertion, with the first bad boundary
inside the fixture. No runtime log polling defect was demonstrated.

The exact focused test failed locally in 0.22 seconds at that same assertion.
The corrected test verifies the wrapper's delegation, prohibits SSH in both
wrapper and checked helper, and preserves the original validation-before-append
and continuity assertions inside the implementation that owns them.

The adjacent hostile-override fixture also extracted only the wrapper. Its
non-errexit shell discarded failed exit-code assertions after missing-helper
errors and returned success from a later assertion. Making the existing shell
strict exposed that second failure; loading the shared complete log-function
fixture repaired it. Independent mutation review also removed the production terminal clamp and
showed that a stub comparison was ignored inside an OR-list call, where Bash
disables errexit. The stub now explicitly returns nonzero on a wrong argument;
the unchanged negative control rejects the missing clamp. The same strict
two-test command failed both before and passed both after, without changing
the tested bounds or expected exit codes:
`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k 'status_polled_over_data_plane_proxy_not_ssh or incremental_log_bounds_ignore_hostile_overrides'`.

Evidence is under `.context/acceptance/log-refresh-test-contract-rca/`:
`runtime-failure.log`, `before.log`, `siblings-before.log` (the original false
pass), `strict-siblings-before.log`, `strict-siblings-after.log`, and
`transport-after.log`. The registered benchmark blackbox now invokes both
contracts early in agents coverage, preventing this pair from waiting until
the long controller lane for discovery. `owning-blackbox-gate-after.log` records
execution of that actual callable. The repair unifies fixture dependencies and
adds no production process, request, timeout change, or work at 10,000 agents.
Cloud acceptance receives no credit from these fixture tests.


### November 2, 2026 recurrence — direct workflow owner extracted

PR1580 extracted startDirectWorkflow from agentLifecycleService.ts into
agentDirectStartService.ts for independent-spawn retry reuse, but the unchanged
unit contract still searched the old file. Native unit failed with
`startDirectWorkflow startAgentWorkflowExecution params should be found`.
Gate: INTRODUCED by this extraction. The actual taskQueue pass-through remains
in the extracted owner; no runtime queue behavior is changed to satisfy a test.

Point the original source-reader at agentDirectStartService.ts. Every assertion
is retained, including descendant taskQueue and durable-start deadline checks.
The same unit then passes, with the corrected-path diagnostic taking0.277s and
canonical four-file account/direct-start unit invocation passing4/4. Evidence:
.context/deploy-boxes-default-20261102/direct-taskqueue-proof/ and
stabilization-account.log. This source-ownership repair has no DB/provider call
or budget change and does not substitute for final full backend acceptance.

## Human feedback

None recorded.

## Reusable lesson

When production policy moves behind a module boundary, update structural guards
to verify the owning module and its call site instead of grepping the old
monolith.
