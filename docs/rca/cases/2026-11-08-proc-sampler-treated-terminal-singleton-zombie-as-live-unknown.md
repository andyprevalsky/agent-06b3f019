---
id: 2026-11-08-proc-sampler-treated-terminal-singleton-zombie-as-live-unknown
date: 2026-11-08
title: Process memory sampler treated an identity-verified terminal singleton zombie as an unreadable live tree
surface: harness
component: deploy-process-memory-sampler
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "scripts/run_deploy_pipeline.py:resident_mb maps smaps_rollup ESRCH plus an existing proc directory to UNKNOWN even for a freshly verified same-birth singleton zombie"
symptoms:
  - "ProcessLookupError errno 3 reading smaps_rollup"
  - "resident_unknown followed by sample_return None"
  - "same-birth current Z num_threads 1 remains UNKNOWN"
tags:
  - deploy
  - proc
  - pss
  - zombie
  - thread-group
sources:
  - commit bd5db328d8fa593357444ca4dab5a04d277b3652
  - plan:.context/rca-google400/round55-active-rca/diagnostic/ACTUAL_RUN_1
  - plan:.context/rca-google400/round55-active-rca/zombie-candidate/singleton-revision-result.json
  - plan:.context/rca-google400/round55-active-rca/zombie-singleton-independent-review.json
repro: scripts/tests/run-deploy-pipeline.test.py checks check_identity_verified_zombie_memory and check_identity_verified_zombie_memory_real; independent fresh RED/GREEN pairs
status: fixed
---

## Problem

This case concerns a newly observed process-memory observation boundary, not a proved cause of the earlier full-51 structural assertion failure. The original `check_materialized_reservation_credit` final-None failure remains unexplained: its inner temporary receipt was removed, and an exact unchanged owning-file diagnostic subsequently passed. That diagnostic is NONREPRO of the historical outcome, not a repair or acceptance pass.

The completed diagnostic nevertheless retained eight actual `ProcessLookupError`/ESRCH failures in `resident_mb`. Original enumerated stat locals and explicitly later diagnostic stat reads showed the same PID/birth and `Z`; each became `resident_unknown` and a `None` tree sample. Example PID 3610447 had birth 23862398 in scan 4. These observations alone did not prove that its entire thread group had terminated, because the observer did not retain thread count.

The existing sampler uses whether `/proc/PID` still exists to distinguish a vanished process from a live unreadable one. A genuinely terminal, unreaped singleton zombie retains its proc directory while its memory map is absent. It therefore invalidates the process-tree sample rather than contributing zero resident memory. This is conservative but unnecessarily loses a valid observation and keeps the whole reservation.

## Diagnosis

First bad boundary: `sample_lane_tree_memory` → nested `resident_mb` → failed `smaps_rollup` read → proc-directory-exists predicate → `None`. The runtime pass then clears the latest anonymous and total PSS values, deliberately retaining only historical peaks. No previous sample should be reused as current evidence.

Fresh light owning tests use the original producer bytes at a stable ignored path and the proposed producer bytes at that identical path. The fake-proc function and the actual forked, unreaped single-child zombie function each independently failed the unchanged new zero-memory assertion on the original producer and passed on the revised candidate. The full owning test module was imported without main, only `DRIVER` was overridden, and the existing fixture-event bound stayed unchanged. The physical child was reaped in its existing exact-child `waitpid` finally on RED and GREEN without signals.

A rejected intermediate rule returned zero for any same-birth current leader `Z`. Independent review Z1 correctly identified a live-peer counterexample. This was reviewer feedback, not human feedback. The optional ignored physical diagnostic confirmed it: `pthread_exit` left a zombie leader with two threads while a live peer retained 32,896 kB anonymous PSS. The broad rule returned zero and failed the negative assertion; the singleton revision returned UNKNOWN and passed. Each diagnostic child was released through its owned stdin pipe, freed its mapping, exited normally, and was joined with exit 0. The compiler was already installed and is not a dependency of the permanent suite.

The corrected distinction uses a post-failure stat read. After actual ESRCH, zero is allowed only when that read has the same PID and enumerated birth, current `Z`, and an ASCII decimal `num_threads` equal to one. It never skips a process based on an initial zombie snapshot. A reused identity, live process, unreadable or malformed stat/rollup, zero/malformed/multiple-thread count, or any other unproved state stays UNKNOWN. The previously supported genuinely vanished process path and normal PSS calculation remain unchanged.

Primary grounding: [proc_pid_stat](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html) defines thread count at field 20 and start time at field 22. [Linux proc array.c](https://raw.githubusercontent.com/torvalds/linux/master/fs/proc/array.c) obtains the count with `get_nr_threads` while holding the sighand lock. [Linux exit.c](https://raw.githubusercontent.com/torvalds/linux/master/kernel/exit.c), as recorded in the independent review, preserves a zombie leader while peer threads remain and decrements thread count on release. A freshly observed single remaining zombie leader cannot create new peers; counts other than one remain conservative.

Archive searches for `unreadable.zombie|zombie.*(PSS|smaps)` and `defunct.*(thread|memory)|thread.group.*(zombie|memory)` found no same-boundary case. The existing 2026-10-31 final-deferral sampling and 2026-11-06 allocation-order fixture cases were read. Their first bad boundaries are fixture assumptions/order, not the sampler's exited-process classification. This draft is therefore a new mechanism case, not an asserted recurrence or an attribution of the historical failure to either old case.

## Solution

Integrated mechanism repair, independently reviewed and verified through the complete canonical owning file: retain the enumerated birth and, only after ESRCH with an existing proc entry, check a fresh same-PID/same-birth/current-Z stat with strictly parsed singleton thread count before contributing zero. Do not retry the rollup, substitute an old observation, weaken live-unknown conservatism, change freshness, or alter admission budgets.

The ignored diff is `round55-active-rca/zombie-candidate/proposal.unapplied.diff`. Its producer SHA256 is `92e98668461d686f7cd8d289001d4354d8b7b8ba98bb5de4d276e4479b68ec2b`; its owning test SHA256 is `0bb9d5948d478a05915f1adac9c878ef8da2b9264aa386373460530389bb8c4d`. The diff SHA256 is `b75eea3cd10e59e0dfb32ba4bddb6062c9a5b311022a547b23f6148e574cc6f3`.

New fake-proc controls cover singleton S→Z and Z→Z, live EPERM, live ESRCH, reused birth, stale initial Z followed by a new live identity, malformed stat/rollup, thread counts 0/2/malformed/negative/fractional, vanished process, valid PSS, and one original rollup read without retry. The physical singleton function is independently runnable so its RED is not masked by the first fake-proc assertion. Both are registered in the existing owning file. Existing assertions, deadlines and concurrency limits remain unchanged.

Exact light commands, identical before and after the producer swap:

- `PYTHONDONTWRITEBYTECODE=1 python3 .context/rca-google400/round55-active-rca/zombie-candidate/run-owning.py fakeproc`
- `PYTHONDONTWRITEBYTECODE=1 python3 .context/rca-google400/round55-active-rca/zombie-candidate/run-owning.py real-zombie`

Both exited 1 on exact root buggy bytes and 0 on the revised ignored candidate. Initial standalone import errors were separately archived as invalid attempts, not causal RED. All source/result/command hashes and closure facts are in `singleton-revision-result.json`. The original broad-rule evidence remains in `superseded-z-only/`.

The complete canonical owning file, including both new registered functions and every original assertion, finished with native exit 0, supervisor exit 0, quiescent true, no remaining descendants, no TERM/KILL and no error. Evidence is retained in `round55-active-rca/zombie-canonical-owning/{native.log,supervisor.json,terminal.json}`. This fixes the demonstrated singleton-zombie mechanism; the historical full-51 final-None subtype remains UNKNOWN. Normal new-source full gates and production deployment remain separate requirements. Golden reference: not applicable; no prompt, schema or agent-recovery hunk.

## Human feedback

The standing user task preserves Freedom, prohibits phone reset and production-environment changes, and requires the original validation scope without benchmark substitutes or relaxed checks. No incident-specific human feedback on Linux process-memory accounting was recorded. The rejected broad-Z rule and the singleton-thread guard came from technical review, not a human instruction.

## Reusable lesson

Count an unreadable process as memory-free only after fresh identity and whole-thread-group terminal evidence, and keep unproved live or reused identities UNKNOWN.
