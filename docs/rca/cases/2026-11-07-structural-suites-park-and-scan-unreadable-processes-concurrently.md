---
id: 2026-11-07-structural-suites-park-and-scan-unreadable-processes-concurrently
date: 2026-11-07
title: deploy-command-structural failed on a Blacksmith VM because a sibling suite's non-dumpable fixture child was alive while deploy-test-cycle scanned /proc
surface: harness
component: deploy-structural-gates
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/run-deploy-structural-gates.py ran deploy-test-cycle (whose quiet() refuses on any same-user process with an unreadable cwd for 2 s), deploy-test-plan and deploy-structural-runner (which park exactly such PR_SET_DUMPABLE=0 children as fixtures) at the same time
symptoms:
  - "ValueError: local cleanup: worker root process 215334 is unverifiable"
  - "PermissionError: [Errno 13] Permission denied: '/proc/215334/cwd'"
  - "ERROR: test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts (__main__.StructuralSupervisorCleanup"
  - "deploy-test-cycle exit=1 (Ran 188 tests, FAILED (errors=1))"
tags:
  - deploy-command-structural
  - blacksmith
  - proc-scan
  - non-dumpable
  - concurrent-suites
  - eacces
sources:
  - PR #1747 deploy attempt 2, gate deploy-command-structural at 768b04db49 (GitHub Actions run 42394708631, Blacksmith runner, user runner)
  - PR #1751 deploy attempt 2 (case 2026-11-07-local-cleanup-quiet-unguarded-proc-read: same pid range 2153xx, process never identified)
repro: python3 scripts/tests/run-deploy-structural-gates.test.py StructuralGateRunnerTests
status: fixed
---

## Problem

The Blacksmith gate for PR #1747 ran `scripts/run-deploy-structural-gates.py --max-workers 4`.
Suite `deploy-test-cycle` ended `Ran 188 tests in 27.2s`, `FAILED (errors=1)`: the second-last test,
`StructuralSupervisorCleanup.test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts`,
reached `quiet(root)` and was refused with `worker root process 215334 is unverifiable`. The other 187
tests and all other suites passed. PR #1751 hit the same family one run earlier (pid 215386, eleven errors) and
recorded the unreadable process as never identified.

## Diagnosis

Gate: NOT_INTRODUCED. The scan, its tests and the runner are byte-identical to main
(`git diff origin/main HEAD -- scripts/deploy_test_cycle.py scripts/deploy_test_local_cleanup.py
scripts/deploy_test_process.py scripts/tests/deploy-test-cycle.test.py` is empty).

The unreadable process is identified by sampling. A sampler (`/proc/<pid>/cwd` readlink for every same-uid
process, printing comm, state, parent and argv at first sight) ran beside the full structural runner on
the devbox. It saw only test fixtures: `python3 -c "... prctl(4,0) ..."` children, in three families.
`deploy-structural-runner` (its foreign-unreadable sibling and owned-guest cases),
`deploy-test-plan` (`InterruptedProcessObservation`, `CHILD` sleeping up to seconds with dumpable cleared)
and `deploy-test-cycle` itself (`LocalCleanupProcessObservation` and the end-to-end observation case). Two
different test processes (distinct parent pids) held such children within three seconds of each other
(284 to 302 s into the run). On the Blacksmith VM `deploy-test-plan` started at 210.5 s while
`deploy-test-cycle` was still on its last tests (189.6 to 216.9 s). `quiet()` scans the whole host, cannot tell a
sibling suite's fixture from a leaked process, and (correctly) fails closed after its 2 s re-observation.
A transient overlap longer than 2 s therefore reads as an unverifiable process. The devbox sweeps never overlapped
by luck of timing; a many-core runner with four workers does.

First-bad boundary: two kinds of suites that must not coexist were scheduled concurrently by the
runner. Making `quiet()` more tolerant would trade away its fail-closed proof; skipping a process without
positive evidence is the wrong direction.

## Solution

`Gate.exclusive` in `scripts/run-deploy-structural-gates.py`: jobs sharing a non-empty group never run
at the same time (`next_launchable`: the first pending job whose group no running job holds; other gates keep
using the free workers). `deploy-test-cycle`, `deploy-test-plan` and `deploy-structural-runner` share
`PROC_OBSERVATION`. Total wall time is unchanged in practice: the group is about 100 to 170 s serial and the
remaining suites fill the other workers.

Regression, `scripts/tests/run-deploy-structural-gates.test.py` (registered as `deploy-structural-runner`):
`test_exclusive_group_jobs_never_overlap_while_other_gates_keep_running` (fake gates record monotonic start and
end: grouped jobs are strictly sequential while an ungrouped gate still starts immediately; fails on a
scheduler that ignores the group) and `test_every_suite_with_a_non_dumpable_fixture_is_in_the_proc_observation_group`
(any `scripts/tests/*.test.*` file that clears dumpable must be a registered gate in the group, so a new fixture
suite cannot reintroduce the overlap).

10k-agent behavior: not agent-scaled; one scheduling decision per structural job.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

A suite that parks a process the host scan must refuse, and a suite that scans the host, are one critical section: schedule them as one, not as unrelated gates that are only separated by luck.
