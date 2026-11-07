---
id: 2026-11-07-local-cleanup-quiet-unguarded-proc-read
date: 2026-11-07
title: Local-cleanup quiet() scan aborted every reconcile when a same-user process answered EACCES for /proc/<pid>/cwd
surface: harness
component: deploy-local-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_local_cleanup.py quiet() resolved /proc/<pid>/cwd of every same-uid process with only FileNotFoundError and ProcessLookupError tolerated, so one unreadable (non-dumpable or exiting) process aborted the proof as "missing or unknown evidence"
symptoms:
  - "PermissionError: [Errno 13] Permission denied: '/proc/215386/cwd'"
  - "cwd = (process / 'cwd').resolve(strict=True)"
  - "ValueError: local cleanup: missing or unknown evidence"
  - "ERROR: test_no_admission_failed_card_can_resume_only_with_bound_physical_closure (__main__.InterruptedCardRecovery"
  - "deploy-test-cycle exit=1 (deploy-command-structural on a Blacksmith runner, FAILED (errors=11))"
tags:
  - deploy-test-cycle
  - local-cleanup
  - proc-scan
  - eacces
  - non-dumpable
  - blacksmith
  - concurrent-suites
sources:
  - PR #1751 deploy attempt 2 gate deploy-command-structural, source 3288396770 (GitHub Actions run 42361811964, job 128371595706, Blacksmith runner, user runner); log .context/deploy-pipeline-3288396770/attempts/2/initial/deploy-command-structural/remote-artifact/files/.context/deploy-worker/ceb5f5f4d4ecf8808c84348f158edfa3df85474fa8975f774f4816054beb93e3/144064eb01cf8837a141291439ac9cc208cc6763a9f025bf72c7056614840f20.log
  - PR #1721 (main's namespace_quiet fix for the same race); sibling case docs/rca/cases/2026-11-07-interrupted-custody-scan-aborted-on-exiting-process.md
  - memory:export-helper-proc-scan-permission-flake (PR #1593, same mechanism class)
repro: python3 scripts/tests/deploy-test-cycle.test.py LocalCleanupProcessObservation InterruptedCardRecovery
status: fixed
---

## Problem

The Blacksmith gate `deploy-command-structural` for PR #1751 (source 3288396770,
attempt 2) ran `scripts/run-deploy-structural-gates.py --max-workers 4`. Suite
`deploy-test-cycle` ended `Ran 172 tests in 19.819s`, `FAILED (errors=11)`, all
eleven from `deploy_test_local_cleanup.quiet()`:

```
File ".../scripts/deploy_test_local_cleanup.py", line 160, in quiet
    cwd = (process / 'cwd').resolve(strict=True)
PermissionError: [Errno 13] Permission denied: '/proc/215386/cwd'
... ValueError: local cleanup: missing or unknown evidence
```

The same pid 215386 appears in all eleven: InterruptedCardRecovery (1),
InterruptedLocalRecovery (5), LocalCleanup (3), StructuralSupervisorCleanup (2),
that is every test that reaches `quiet(root)` while the process was alive. The suite passes on
the devbox (172 tests, 28.7 s, `OK`) and passed on the previous source's Blacksmith VM.

## Diagnosis

Gate: NOT_INTRODUCED. `git diff origin/main...3288396770 -- scripts/deploy_test_local_cleanup.py`
is empty; the PR changed `scripts/deploy_test_cycle.py` (no hunk touches reconcile, quiet or any
/proc scan) and added test classes, none inside the failing paths except a fixture port change
in InterruptedLocalRecovery. The unfixed module, byte-identical on both sides, fails with the
identical error on this devbox for any non-dumpable same-user process (below), so the defect
pre-dates the PR; the PR only ran it beside a host process that exposed it.

`quiet()` lists every `/proc/<pid>`, skips other users by the directory owner, then reads
`cwd` and `cmdline`. The directory owner of `/proc/<pid>` stays the effective uid even for a
non-dumpable process (only non-world-readable entries such as `cwd` and `fd` are re-owned to
root), so a same-user non-dumpable process passes the owner filter and `readlink(cwd)` then
returns EACCES from `ptrace_may_access`. Only FileNotFoundError/ProcessLookupError were
tolerated, so the first such process aborted the whole proof, and `reconcile` re-labelled
it as the opaque `missing or unknown evidence`.

First-bad boundary: an unreadable `/proc` entry treated as a fatal verdict. A read failure is
neither proof of absence nor of a leak (CLAUDE.md rule 1: native process-observation failures
are read failures; require positive evidence before cleanup).

What was unreadable is unproven. Evidence: the job log of run 42361811964 shows the setup
step's own report (`scripts/ci/deploy-gate-setup.sh`, "ready" step, lists same-uid processes
with an unreadable cwd) printed no line, so no such process existed when setup ended (the
`user@UID.service` stop worked); pid 215386 therefore appeared during the 7.5 minute gate
(09:56:51 to 10:04:18 UTC) and stayed unreadable across four test classes. Three concurrent
suites ran with `deploy-test-cycle` (kill-services 175.6 to 208.1 s, benchmark-live-results[6/6],
and the suite itself); its identity, parent and state were not captured. Zombies are not
the cause: a zombie answers FileNotFoundError for `cwd` (measured on this kernel, 6.1.158), which
`quiet()` already skipped.

Archive: searches "PermissionError Permission denied /proc cwd non-dumpable same-user process",
"namespace_quiet unverifiable original namespace process Blacksmith", "local cleanup quiet worker
root still has a live process missing or unknown evidence PermissionError" and "suite passes on devbox
fails on Blacksmith runner concurrent suites same-uid process". Relative of
2026-11-07-interrupted-custody-scan-aborted-on-exiting-process: same class, different scanner.
That case fixed `namespace_quiet` only, even though it recorded that "a persistently non-dumpable
process fails at the cwd read" and named `deploy_test_local_cleanup.py` as the sibling. The guardrail
that failed to hold was the fix shape: a per-scanner patch instead of one shared policy.

Deepest owned cause: two copies of a process-table scan, one hardened and one not.
Sibling failures this prevents: the same abort in `card_preflight`, `structural_cleanup`,
`interrupted_card`, `interrupted_worker`, `validate` (backend) and `still_bound`, all of which end
in `quiet(root)`.

## Solution

`observe_same_user_processes(inspect, unverifiable, seconds)` in
`scripts/deploy_test_interrupted_cleanup.py` holds the one policy: re-observe an unreadable
same-user process until a deadline, skip it once it exits or its real uid (from
`/proc/<pid>/status`) is another user's, and call `unverifiable(process)` (which raises) only while
it stays unreadable and alive. `namespace_quiet` now calls it with its previous 2 s window and
messages (behavior unchanged; its existing regressions pass). `quiet()` calls it with a 10 s
window (`OBSERVATION_SECONDS` in `deploy_test_local_cleanup.py`): the unreadable process lived at least
across four test classes, and reconciliation is launch-only, so a longer bound costs nothing on a
healthy scan. `quiet()` also reads argv first (always readable), so a process that names the root
is refused as `worker root still has a live process` even while its cwd is unreadable, and a refusal for an
unreadable process now names it: `worker root process N is unverifiable (comm, state S, parent P)`,
so a persistent occurrence is diagnosable instead of opaque. A genuinely held root is refused exactly
as before; nothing is skipped without positive evidence (exit or another uid).

Regression: `LocalCleanupProcessObservation` (6 cases) and
`InterruptedCardRecovery.test_transiently_unreadable_same_user_process_does_not_block_reconcile`
in `scripts/tests/deploy-test-cycle.test.py` (deploy-command-structural gate, registered as the
`deploy-test-cycle` suite). The fixture is a real Linux child that clears `PR_SET_DUMPABLE`, which is
unreadable to its same-user parent exactly like the VM process. Pre-fix on the PR source: 7 of 9 errored,
the end-to-end case with `PermissionError ... '/proc/<pid>/cwd'` re-labelled `local cleanup:
missing or unknown evidence`; the two control cases (cwd in the root, argv names the root, both readable)
passed. Post-fix: 9 of 9 pass; `deploy-test-cycle` (179 tests) and `deploy-test-plan` (55 tests) passed five
consecutive runs each.

10k-agent behavior: no agent-scaled work. One bounded `/proc` scan per reconcile; no wait unless a
process is unreadable, then at most 10 s per unreadable process before the first refusal.

Open: pid 215386 was never identified, so a process that stays unreadable longer than 10 s still
fails closed (by design); the new message will name it. The same exposure exists in the 2 s window of
`namespace_quiet`; widen it with the same keyword if its message ever names a live pid.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Give every scan of other processes' `/proc` entries one shared bounded re-observation policy, because a hardened copy beside an unhardened one only moves the flake to the next scanner.

## Merge note (PR #1751)

Main landed a shared re-observing /proc scan for both custody scanners (commit 8bc2552699, PR #1716) while this deploy ran. The PR #1751 sync kept main's implementation of `deploy_test_interrupted_cleanup.py` and `deploy_test_local_cleanup.py` and dropped this branch's helper and its `LocalCleanupProcessObservation` tests; this case documents the failure, the diagnosis and the regression shape, which main's own tests now cover.
