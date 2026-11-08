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
  - "ERROR: test_reaped_structural_orphans_allow_launch_only_and_keep_all_failure_facts (__main__.StructuralSupervisorCleanup"
  - "ValueError: local cleanup: worker root process 211414 is unverifiable"
  - "PermissionError: [Errno 13] Permission denied: '/proc/211414/cwd'"
  - "ERROR: test_incomplete_foreign_changed_or_live_evidence_refuses_atomically (__main__.InterruptedLocalRecovery"
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
  - PR #1762 deploy cycle 5, gate deploy-command-structural at ac0421d93c (GitHub Actions run 42401784705, job 128490940763, artifact 13586285736 deploy-gate-result)
repro: python3 scripts/tests/run-deploy-structural-gates.test.py StructuralGateRunnerTests; python3 scripts/tests/deploy-test-cycle.test.py InterruptedLocalRecovery (with an unrelated non-dumpable same-user process alive)
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

## Recurrence (PR #1762, 2026-11-08)

The Blacksmith gate for PR #1762 cycle 5 (source ac0421d93c, run 42401784705) failed the same way: `deploy-test-cycle`
`Ran 188 tests`, `FAILED (errors=1)`, `InterruptedLocalRecovery.test_incomplete_foreign_changed_or_live_evidence_refuses_atomically`
refused at its final `self.reconcile()` with `PermissionError: [Errno 13] Permission denied: '/proc/211414/cwd'` and
`worker root process 211414 is unverifiable`. The setup step's unreadable-cwd report printed nothing, so pid 211414 appeared
during the run. The source predates `Gate.exclusive` (`git show ac0421d93c:scripts/run-deploy-structural-gates.py` has no
`PROC_OBSERVATION`; it reached main through PR #1747), and the runner's own timings show `deploy-test-plan` (223.5 to 246.4 s)
overlapping `deploy-test-cycle` (216.6 to 243.6 s). That overlap is the likely source; the process identity was not captured.

The guardrail that still failed: the suite itself was not hermetic. Every test that reaches `quiet()` or `namespace_quiet()` scanned the
whole host, so any unrelated same-user process that stays unreadable (another suite's fixture, a runner's `(sd-pam)` restarted mid-job)
fails the test, whatever the scheduler does. Local repro on main 4a0e080d7: with a `setsid` process that clears `PR_SET_DUMPABLE` alive,
the unchanged assigned test fails with the identical `worker root process <pid> is unverifiable`; without it, it passes.

Fix: `deploy_test_process.process_entries()` is now the scan's single population (production unchanged: every `/proc/<pid>`).
`scripts/tests/deploy-test-cycle.test.py` narrows it for the whole module (`setUpModule`) to the test process and its descendants,
the only processes any of its fixtures create. Every refusal case keeps its real child: `LocalCleanupQuietScan` still refuses a persistently
unreadable child, the root-process cases still refuse a child in the root. Regression
`InterruptedLocalRecovery.test_unrelated_unreadable_host_process_refuses_production_scan_only` starts a real re-parented non-dumpable
process and asserts that the production population contains it and refuses reconcile without changing state, and that the suite's
view excludes it and reconcile proceeds. With an unrelated unreadable process alive throughout, the assigned test and the full suite pass.

## Human feedback

None recorded.

## Reusable lesson

A suite that parks a process the host scan must refuse, and a suite that scans the host, are one critical section: schedule them as one, not as unrelated gates that are only separated by luck. Then keep the scanning suite hermetic too, scoping its fixture scans to its own process tree, because the host can always hold an unreadable process no scheduler controls.
