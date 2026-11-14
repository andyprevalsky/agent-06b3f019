---
id: 2026-11-08-native-launcher-readiness-fixture-missing-exports
date: 2026-11-08
title: Native launcher fixture replaced the readiness module with an obsolete interface
surface: harness
component: e2b-native-launcher
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: e2b-native-launcher.test.ts replaced e2bWsReady with only waitForSandboxWsServer after the merged launcher began calling two additional exports
repro: node --experimental-test-module-mocks --import tsx back-end/src/tests/unit/e2b-native-launcher.test.ts
symptoms:
  - TypeError import_e2bWsReady.wsStartupBudgetMs is not a function
  - TypeError (0 , import_e2bWsReady.wsStartupBudgetMs) is not a function
  - createClaudeCodeSessionUnlocked e2b.ts:467
  - e2b-native-launcher.test.ts
tags:
  - e2b
  - native-launcher
  - fixture
  - module-mock
  - readiness
sources:
  - PR #1635
  - commit 5809574d5e0323fb2f285ce34746f955acde7593
  - commit 7c93c06aedbf7f406a22697a2e48bceed4e1869f
  - commit 131f588d495c51c041d2828bc652ad3edd4db3ae
status: fixed
---

## Problem

The original supported child-mode invocation against the actual merged launcher
failed before completing its identity assertions. With the custody preload and
BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL=0 preserved, it exited 1 with
`TypeError: (0 , import_e2bWsReady.wsStartupBudgetMs) is not a function` at
`e2b.ts:467`. E2B_LAUNCHER_MUTATION_PATH named the unmodified actual source and
E2B_LAUNCHER_MUTATION_PROVIDER was claude; this was not a negative mutation.
The private reproduction used an ignored copy of exact commit 5809574d.

## Diagnosis

Critical path: native test configure -> module mock -> actual provider launcher
-> startup budget / readiness outcome -> launch identity assertions.
The retained fixture replaced the complete readiness module with a single
waitForSandboxWsServer export and its obsolete two-field return shape. Main
added wsStartupBudgetMs and wsReadinessOutcome to the runtime call path. Both
were missing; repairing only the first would expose another setup failure.
The additional failed-restore import is only called by a callback that the
project restore double does not invoke, and the create-slot import is unused.
Neither needs a speculative stub for this tested path.

Comparison gate: INTRODUCED by the merge relative to CLI parent
7c93c06aedbf7f406a22697a2e48bceed4e1869f. The unchanged merged fixture passes
with that parent's e2b.ts and e2bWsReady.ts and fails with the merged runtime.
The main parent has no native-launcher fixture; transplanting this fixture onto
its runtime fails earlier at the foreign-session assertion because that runtime
lacks the retained CLI custody change. That is not evidence of the readiness
failure on the main parent. Preserve both parents' intended behavior.

Archive searches used `wsStartupBudgetMs is not a function` and
`e2b launcher mock fixture readiness`, followed by a literal source search.
No case described this boundary. The CLI validation-harness interference and
Codex OAuth missing-event-interface cases are relatives, not this incident.
There is no executing Rose agent or report_bug record involved in this unit
fixture; no provider or database query was needed.

## Solution

Import the real, side-effect-free readiness module and spread its exports into
the partial module mock. Override only the external wait and return the complete
ready shape (ready, state, cloneMs, elapsedMs). This eliminates the duplicated
helper-export list while retaining the network-free fixture boundary. It changes
no production source, timeout, assertion, authentication or environment contract.
The existing permanent native launcher test is the regression: the same focused
command fails before the repair and passes after it. Its full native invocation
passes both launchers and all six missing-user/cwd/HOME negative controls.
The owning unit runner discovers this file recursively and invokes Node with
--experimental-test-module-mocks --import tsx; no separate suite was introduced.
At 10k runtime agents this test-only repair has no runtime cost or shared state.
Golden reference: not applicable (no approval-gated hunk).

Private logs, exact commands, parent comparisons and hashes are retained under
.context/cli-nov08-user-sync in e2b-fixture-result.json and the associated logs.
The parent deploy coordinator owns integration and release; this result is an
isolated verified patch, not a completed deployment or whole-backend suite pass.

## Human feedback

The parent task required exact-source ignored scratch, preservation of runtime identity,
owner/auth/project env semantics and all assertions/deadlines, six red mutation
controls and the full native owning unit command. No canonical edits, installs,
provider/DB/resource actions, Kernel/Freedom changes, review or deploy were allowed.

## Reusable lesson

Partially mock only the external operation and preserve the real pure helper exports so merged runtime interfaces cannot outgrow a handwritten module stub.
