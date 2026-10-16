---
id: 2026-07-21-helper-moved-out-of-run-sh-broke-extraction-tests
date: 2026-07-21
title: Tests that extracted a shell helper from run.sh broke when the helper moved into a sourced library
surface: harness
component: cloudbench-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/benchmarks/cloudbench_dependency_sync_test.py extracted backend_ready_budget from scripts/run.sh alone after it moved to scripts/lib/seed-cache.sh"
symptoms:
  - "backend_ready_budget: command not found"
  - cloudbench dependency-sync tests fail after a run.sh refactor
  - blackbox mock lambdas fail with unexpected keyword/positional argument
tags:
  - shell
  - cloudbench
  - test-harness
  - refactor-fallout
  - seed-cache
sources:
  - PR #820
  - PR #1450
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

Two blackbox/harness tests failed as a direct result of the branch's own refactors.
The cloudbench dependency-sync tests died with
`backend_ready_budget: command not found`, and the agents benchmark blackbox failed
because its mock lambdas did not accept newly added arguments.

## Diagnosis

The tests reconstructed a runnable shell fragment by extracting helper functions
**from `scripts/run.sh` only**. When `backend_ready_budget()` was moved into
`scripts/lib/seed-cache.sh` (sourced by `run.sh`), the extraction still succeeded
but produced a fragment missing that function, so the helper was undefined at call
time. The same class of coupling caused the second failure: `_apply_live_fixture`
gained a `tolerate_gpt_code_unavailable` kwarg and a cookie-domains positional, and
the test's arg-less mock lambdas were pinned to the old signature. In both cases the
test encoded an implementation detail (where the code lives / its exact arity) rather
than the behavior, so an ordinary refactor broke the harness rather than the product.

## Solution

`isolated_backend_ready_attempts()` now delegates to `backend_ready_budget()` and
prepends the budget helper plus the `DB_RESTORED` / `FIRST_RUN_SEEDED=false`
defaults that `run.sh` sets, so extraction follows the helper wherever it is
sourced from. The benchmark blackbox mocks were updated to accept the new
kwarg/positional. Landed alongside the ecommerce-slice cloud-bench work
(per-task cookie-domain scoping, seed-cache stale-dump decision plus
`backend_ready_budget` so a restore gets the same health budget as a cold seed,
compute-token sync tolerating an exhausted Codex `gpt_code`, and a Fast-Mode
cache-schema pooler retry).

## Human feedback

October 6 relative: the worker receipt-failure fixture extracted `kill_tree_hard` but omitted its `descendant_pids` dependency after main integration. The full coverage domain failed cleanup; the standalone worker repro reproduced it (28 pass, one fail), and the exact receipt-failure function passed after adding the dependency to the extracted fixture. Production cleanup code was retained. Evidence: `.context/wmh-worker-repro.log`, `.context/wmh-worker-receipt-after.log`. Two other timeout observations passed unchanged in the standalone repro and remain unclassified until full coverage revalidation.

None recorded.

## Reusable lesson

A test that greps or extracts code out of one shell script silently rots when the
helper is moved to a sourced library — source the same libraries the real script
sources instead of reconstructing its body.

## Recurrence: isolated worker cleanup fixture (2026-10-03)

The canonical agents coverage run on `2f52838680f4d490a8d9ef71c76d2b584c3e4ca5`
passed 105 of 106 domains. The worker domain's existing
`test_stack_reaps_services_when_pending_receipt_cannot_be_written` failed after
its extracted `cleanup()` called `remove_isolated_frontend_build`, which the
fixture had not extracted. The original stderr records that missing command;
the original assertion did not record the shell's return code. The aggregate
remains failed, and its cache/unit/coverage tail did not execute.

The same existing case was then called directly with a private process observer.
It failed in 3.638 seconds with shell return code 127. Adding the actual
`remove_isolated_frontend_build` function to the fixture's extraction list made
that same case pass in 6.876 seconds: both worker-exit variants returned the
required shell code 1. All observed shell owners retired. The observer, selector,
environment, production helpers and assertions were unchanged; only the private
receipt label and the one-line fixture dependency addition differed. The real
helper returns immediately when no frontend build is assigned. No no-op stub,
production change, timeout change or weakened cleanup assertion was introduced.

The case remains registered in the existing worker blackbox domain. A focused
worker refresh plus the previously unrun canonical coverage tail is required;
the failed aggregate must not be relabeled as a fresh passing full-suite run.
This recurrence shows why extracting the caller alone does not preserve its
real shell dependency set, including error paths that retain `errexit`.

## Recurrence: shared fleet inventory fixture (2026-10-05)

The canonical agents coverage run on `152f4b7fa3a350e3477870443b499c9eb0c3fcc8`
passed 106 of 107 blackbox domains. The benchmark domain's runtime-retention
selection failed sixteen existing controls with `ValueError: substring not found`.
The inventory publisher refactor moved `registry_meta_value` into the sourced
`cloudbench-inventory.sh`; the retention fixture still read the fleet file alone.
No failing assertion reached the resource-retention implementation. The aggregate
remains failed; it is not acceptance credit or a fresh passing coverage result.

The identical sixteen-case selection reproduced sixteen failures in 3.24 seconds.
Changing only its source loader to the existing `fleet_source_text` resolver made
the unchanged selection pass in 2.12 seconds. All fifty-eight retention controls
then passed in 11.36 seconds on native Linux in the existing review image, with
network disabled and source/test dependencies mounted read-only. Original and
corrected logs remain private under `.context/acceptance/startup-speed-20261005/`.
No resource assertion, fake-provider behavior, timeout, or production code was
changed. These controls continue to execute the real sourced shell helpers.

The sixteen controls also belong in the existing compact deploy gate so a source
location refactor is caught before funded coverage. Independent review and the
final source-bound canonical coverage are required before merge.

## Recurrence: terminal fleet projection and campaign defaults (2026-10-08)

The composed deployment's normal compact benchmark command reported 515 passed,
six failed, and four intentional skips. One pre-service admission control started
before the independently certified source-policy entry was committed; both
parameters passed with that existing-policy entry. The other failures were
fixture composition defects introduced when the fleet's terminal projection
became an explicit helper call. No failing fixture result qualifies a deployment.

The dependency and runtime-retention fixtures extracted recovery or cleanup
callers without `fleet_finalize_released_projection` or
`fleet_publish_recovered_terminal_projection`. A provenance source assertion
still searched for the finish-epoch write inside `cleanup`. The terminal Hub
fixture sliced from `finalize_terminal_projection` to a later cleanup marker;
when the function moved earlier, that slice also executed unrelated top-level
maintenance and provisioning code. The separate normal Descend Command gate
failed before its cancellation assertions because its mocked parser Namespace
omitted newly supported retry defaults.

The corrections compose the actual helper definitions, including metadata and
exact registry retirement, and provide only the fixture's owned sealed audit,
release epoch, and task manifest. The provenance control follows the real
release helper's atomic finish write and verifies its call precedes final
upload. The terminal upload fixture extracts each required function by its
existing source boundary. The campaign fixture supplies the parser's ordinary
flag-off defaults. Production code, provider behavior, task outcomes, cleanup
invariants, negative controls, and all original test timers remain unchanged.

The identical focused dependency selection reproduced three failures and four
passes in 11.80 seconds, then passed all seven cases in 6.51 seconds. The two-case
retention selection reproduced one failure and one pass, then passed both cases
with its original evidence-before-destroy and no-repeat guest-shutdown
assertions. The terminal Hub selection reproduced one failure and two passes in
5.34 seconds; the corrected complete upload owner passed 34 controls in 10.77
seconds. The same Descend Command script reproduced one parser error and two
lifecycle passes, then passed its four, twenty-seven, and three-control groups.
Independent review binds each correction to its exact patch and private normal
RED/GREEN receipts. The complete mandatory command registry must still pass on
the composed source; these focused results claim no fresh whole-suite coverage,
paid task acceptance, native rollout, or LIVE50 credit.


## Recurrence: reusable-bank drain budget owner (2026-10-16)

Full agents coverage at exact source
`8171b24d0f934b38a5b932f836b8726f40b07a96` reported 109 passed domains and
one failed domain. The registered `explore_timeouts_drain_within_deploy_cutover`
case in `spawn_agent.blackbox.py` failed with
`deploy-agents-cooperative-cutover.sh must default DRAIN_TIMEOUT_SECONDS`.
The coverage owner joined exit 1; fast-cache, unit and coverage aggregation did
not run after the blackbox phase failed. Structural and seed follow-ons were
held. The failed full coverage is retained and is not relabelled green.

The existing case searched only the old shell launcher's Bash default. The
reusable-bank implementation moved the unchanged 2700-second budget into the
canonical Python driver, `scripts/worker_pool_cutover.py`, which the shell
launcher invokes. Quick/medium explores remain 600 seconds, deep remains 1800,
and cancellation grace remains 15: the original deepest safety inequality is
still **1815 < 2700**. Driver expiry retains the old bank; this test failure did
not demonstrate an activity-drain runtime regression.

Archive searches used the literal assertion and `helper moved extraction test
source file stale`; this is the existing source-location-coupled fixture class.
The isolated test-only correction pins the launcher's canonical driver handoff,
reads the driver's single integer budget with the Python AST without importing
or executing it, and preserves the exact per-depth safety inequality and native
Fly shutdown-grace assertions. Only that existing test and its explanatory
docstring change. No runtime, timeout, policy, fixture response, skip, evaluator,
or test registration was altered.

The original registered RED was executed by the normal full coverage command:

```bash
cd agents
source venv/bin/activate
bash ../scripts/run-deploy-stage agents-coverage-blackbox --reuse-passed -- env AGENTS_COVERAGE_CONCURRENCY=6 bash scripts/run-coverage.sh
```

After all that coverage owner's children joined, the corrected normal owning
registry was run once in an isolated exact-source copy:

```bash
cd /home/boxes/rose/.context/lantern-spawn-drain-8171/agents
/home/boxes/rose/agents/venv/bin/python /tmp/lantern-review-reds-run-owner.py spawn-agent
```

The private wrapper sets only offline test-process placeholders and invokes the
unchanged `scripts/run_blackbox_tests.py spawn-agent` registry through `runpy`.
The registered case and complete spawn-agent owner passed in 2.7 seconds.
Original domain RED and post-correction owner GREEN are retained under
`.context/test-runs/agents-coverage-20261016-185506-802488/spawn-agent.log` and
`.context/spawn-drain-8171-rca/owning-green.log`. Canonical scratch-local Ruff,
changed-hunk formatting, and diff checks passed. All owned verification processes
joined. ROOT remained at the original immutable source for sibling verification;
only the detached correction was prepared. The full Test Loop on the composed
new source is still required; no whole-coverage, native deployment or provider
acceptance credit is claimed from this focused GREEN.
