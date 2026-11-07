---
id: 2026-11-07-interrupted-custody-scan-aborted-on-exiting-process
date: 2026-11-07
title: Interrupted-custody namespace scan aborted the whole proof when an exiting same-uid process answered EACCES for its fd table
surface: harness
component: deploy-interrupted-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_interrupted_cleanup.py namespace_quiet treated EACCES on /proc/<pid>/fd (and fd links) of a same-uid process as fatal, although an exiting process is unreadable for a few milliseconds before it disappears
symptoms:
  - "ValueError: interrupted custody proof refused: [Errno 13] Permission denied: '/proc/206686/fd'"
  - "PermissionError: [Errno 13] Permission denied: '/proc/206686/fd'"
  - "ERROR: test_static_and_cloud_reconcile_preserve_originals_and_history (__main__.InterruptedCustody.test_static_and_cloud_reconcile_preserve_originals_and_history) (cloud=True)"
  - "deploy-test-plan exit=1 (deploy-command-structural on a Blacksmith runner)"
tags:
  - deploy-test-cycle
  - interrupted-custody
  - proc-scan
  - eacces
  - flake
  - blacksmith
sources:
  - PR #1751 deploy attempt 2 gate deploy-command-structural (Blacksmith runner, user runner)
  - commit ec1b265e79 and ff097a1748 (namespace_quiet and its test, from main)
  - memory:export-helper-proc-scan-permission-flake (same mechanism class, PR #1593)
repro: python3 scripts/tests/deploy-test-plan.test.py InterruptedProcessObservation
status: fixed
---

## Problem

`python3 scripts/run-deploy-structural-gates.py --max-workers 4` ran on a 4 vCPU
Blacksmith VM (user `runner`) and exactly one of 67 suites failed:
`deploy-test-plan`, `InterruptedCustody.test_static_and_cloud_reconcile_preserve_originals_and_history`
(cloud=True), with `PermissionError: [Errno 13] Permission denied: '/proc/206686/fd'`
raised at `namespace_quiet` (`for fd in (process / 'fd').iterdir()`) and re-raised as
`interrupted custody proof refused`. The same suite passes alone and on the devbox.
The traceback shows the cwd read had already succeeded.

## Diagnosis

Gate: NOT_INTRODUCED. `scripts/deploy_test_interrupted_cleanup.py` is
byte-identical between the PR source (9997bca37f) and its merge-base with main
(308315a4bc), and the PR changed no `InterruptedCustody` test hunk. The unfixed
module fails with the identical error on a plain devbox, so any host that runs
other same-uid processes beside the scan is exposed.

`namespace_quiet` lists every `/proc/<pid>`, skips other users, then reads
cmdline, cwd and the fd table. Only FileNotFoundError and ProcessLookupError were
tolerated, so an EACCES from a process that changed state between the listing and
the read aborted the whole custody proof.

Measured on the real kernel (6.1.158, uid 1002, this devbox, unfixed code):
the actual function raised the exact CI error on 0.4 to 0.7 percent of scans
(4/934, 30/5393, 14/1969, 8/1411), never at cwd or cmdline. A 7.05 M-observation
sampler recorded 210 unreadable same-uid entries: 209 had PF_EXITING (0x4) in
`/proc/<pid>/stat` flags, all 210 were gone within 37 ms (median 2 ms) and none
became readable. Typical snapshot: state R, empty cmdline, no exe link, cwd
readable, fd table EACCES. A persistently non-dumpable process (what
`scripts/ci/deploy-gate-setup.sh` removes by stopping `user@UID.service`) instead
fails at the cwd read, so pid 206686 was an exiting short-lived sibling process
from the other three concurrent suites, not a runner daemon. Its identity cannot
be recovered from the retained log.

Deepest owned cause: a process-table scan that treats one non-atomic, momentarily
unreadable `/proc` entry as authoritative. The same mechanism class fired in
`scripts/cloudbench-controller-export.py` (PR #1593, bounded re-observation);
the sibling scanner `deploy_test_local_cleanup.py` reads only cmdline and cwd, and
none of about 11 M observations failed there. An unreadable live process cannot
be proven quiet or proven holding, so the correct result is neither pass nor leak:
re-observe, skip if gone, otherwise fail closed with a distinct message.

Archive searches: "Permission denied /proc fd PermissionError interrupted custody
namespace_quiet", "unreadable /proc same-uid EACCES scan fail closed", "exiting
process EACCES fd /proc scan transient re-observe". Relatives: 2026-11-07-custody-fixture-claimed-live-hub-port
(same test, host-state leak), 2026-10-16-process-scan-swallowed-observation-deadline
(the fix does not swallow deadlines). Novel for this module.

## Solution

`observed(process, read)` re-runs the per-process observation up to
`OBSERVATION_ATTEMPTS` (5) times, `OBSERVATION_DELAY` (0.2 s) apart. Ownership is
re-read each attempt (a process that became another user's, for example through
sudo, is skipped), a vanished process is skipped, and a process that stays
unreadable and alive raises `cannot observe pid N: EACCES ...`, distinct from the
live consumer and file holder refusals. Argv (always readable) is checked before
the cwd read, so an unreadable process that names the namespace is still reported
as a consumer. Every positive refusal is unchanged.

Regression: `InterruptedProcessObservation` in `scripts/tests/deploy-test-plan.test.py`
(deploy-command-structural gate). It uses a real child with `PR_SET_DUMPABLE=0`,
which is unreadable to its same-uid parent like an exiting process, plus injected
EACCES on the fd listing and fd links. Before the fix it failed with the CI error
(`/proc/<pid>/fd`, `/proc/<pid>/fd/0`, `/proc/<pid>/cwd`); after, the same tests
pass and 0 of 4274 real-kernel scans failed under fork/exit churn.

10k-agent behavior: no agent-scaled work; one bounded scan per reconcile, at most
0.8 s extra per persistently unreadable process, and none otherwise.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Treat EACCES on a same-uid `/proc/<pid>` entry as a bounded re-observation, never as proof or a fatal error, and fail closed naming the pid only while it stays unreadable and alive.

## Merge note (PR #1751 sync with main, 2026-11-07)

PR #1721 landed an independent fix for the same race on main (`8e0c3c79c8`, `a32dec2fb2`, `6a85668c16`: the custody scan re-observes an unreadable same-user process by deadline and decides ownership by real uid). The PR #1751 sync kept main's implementation of `scripts/deploy_test_interrupted_cleanup.py` and dropped this branch's duplicate. The branch's `InterruptedProcessObservation` regression stays against main's code (becomes readable while waiting, fd table denied after cwd was read, exits while unreadable, stays unreadable and alive is refused naming the pid, a held namespace is still refused); its owner-change case is covered by main's `test_namespace_scan_reobserves_unreadable_same_user_process`.

