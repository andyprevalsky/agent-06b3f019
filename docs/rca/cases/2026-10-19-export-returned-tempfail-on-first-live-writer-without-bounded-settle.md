---
id: 2026-10-19-export-returned-tempfail-on-first-live-writer-without-bounded-settle
date: 2026-10-19
title: Controller export returned EX_TEMPFAIL on its first live-writer observation and retained the controller
surface: infra
component: cloudbench-controller-export
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-controller-export.py:export (one writer observation returned 75 with no drain), plus writers() reading only the thread-group leader
symptoms:
  - GATE_EXPORT exit=75
  - live controller writers
  - GATE_EXPORT_PENDING machine=<id>; host retained, no release credit
  - "gate.pending.json PENDING_EXTERNAL_OWNER_LIVE export_verified false"
  - shard export ran once and was never retried until cloudbench-resume-controller-export.py --observe/--run
tags:
  - cloudbench
  - controller-export
  - disposable-controller
  - sharded-original600
  - observability-gap
sources:
  - benchmark run original600-1792440129763435696 (fresh-agent polar70, shard-01, machine 891e751f54ede8, source 6d3b7c4da)
  - PR #1546 (branch fix/controller-export-transient-writer-retry)
repro: scripts/tests/cloudbench-disposable-hub-finalize.test.py (QuiescingOriginalsExport.test_transient_writer_at_first_check_settles_into_verified_export, test_persistent_writer_fails_closed_after_bounded_drain; ZombieLeaderWriter.test_live_thread_of_zombie_leader_is_a_writer; Finalize.test_rendered_gate_logs_pending_reason_and_writer_names)
status: mitigated
---

## Problem

This was the fresh-agent 70-task sharded run, `original600-1792440129763435696`.
On shard-01, the guest log `cloudbench-gate-891e751f54ede8.log` shows
`GATE_FAILED_STEPS 1` at 20:35:22Z, `GATE_EXPORT exit=75` at 20:35:30Z, and
`Reaped child process with pid: 1259 and signal: SIGTERM` at 20:35:31Z. The runner
wrote `gate.pending.json` `PENDING_EXTERNAL_OWNER_LIVE` and kept the
performance-8x controller and its 256 GB volume. Nothing retried the export.

About 16 minutes later, a manual `cloudbench-resume-controller-export.py` check
found no non-idle writers, and its export passed on the first attempt
(`controller-export-recovery/check.response.json`, `export.response.json`,
`complete.json` `EXPORT_VERIFIED`).

## Diagnosis

- **The pending was writer-shaped.** The resume tool asserts
  `resumable_pending(custody/pending.json)`. That accepts a record-bound pending,
  or a quiescence-race exception pending. Timing rules out every record-bound
  shape except `live controller writers`: drift exhaustion needs two 10 s settles,
  and the export took 8 s. A Hub retirement timeout is not resumable.
- **First-bad boundary.** `export()` repeated a fresh strict snapshot 3 times on
  drift (RCA 2026-10-18 ext4 writeback). But it returned 75 on the first
  `controller_active_writers` observation, before any settle. The gate runs the
  export once, and the runner has no automatic retry. Any writer still present
  during the seconds after the step therefore retained the controller
  permanently. The repro shows this exact pending shape on main (`75 != 0`).
- **A blind spot in `writers()`, found by adversarial review.** `writers()` read
  only the leader's `cwd`, `fd` and `maps`. A SIGTERMed threaded process, such as
  the `ThreadingHTTPServer` Hub (`agent_link_server.py`, pid 1259 here, per the
  archived owner receipt), can show a zombie leader while another thread is still
  writing. `retire_disposable_hubs` stops waiting at `Z`. Main's `writers()`
  returns `[]` for such a process (`ZombieLeaderWriter` fails on main with
  `[] != [pid]`). That weakened fail-closed, and the same blind spot likely hid
  1259 from the writer check.
- **Open: the writer is unidentified.** The guest `pending.json` was destroyed
  with the host. Fly init logs only signal deaths. The resume tool validated the
  pending but did not journal it. The writer could have been a process that
  exited normally, or a registered fleet controller. `controller_active_writers`
  also counts any `cloudbench-fleet-ownership/*/meta` pid whose birth matches,
  including a zombie. Shard timing does not tell these apart: shard-00's reap came
  later (+10 s) and that shard still passed. So the writer's lifetime is unmeasured.
- **Why ladder.** Why 1: the export treated a transient condition as terminal.
  Why 2: the quiescence contract (wait, then re-check and take a fresh snapshot)
  covered drift but not live writers, and writer detection could not see the
  threads of an exiting process. Stop: a writer that persists must still refuse,
  by design.

## Solution

- **Bounded drain.** `export()` polls `controller_active_writers` every 1 s,
  within one 120 s drain per export, before each strict snapshot. A writer
  still live at the deadline fails closed with `live controller writers`.
  Drift keeps its own 3 snapshot attempts, so a writer no longer consumes one.
- **Why 120 s.** Teardown orphans exited 5–10 s after the step in this run, and
  a fleet machine destroy is bounded at 60 s; 120 s is twice that. It is not a
  measured writer lifetime. The next occurrence's evidence (below) is what
  measures it.
- **Thread-aware detection.** `writers()` reads every live thread
  (`/proc/<pid>/task/*`), so a zombie leader with a writing thread counts as a
  writer. This change only makes detection stricter.
- **Evidence.** The pending records `writer_observations`: elapsed time, pid,
  birth, state, ppid, comm, thread count and registry. It records no argv. The
  gate prints `GATE_EXPORT_PENDING_DETAIL`, with the registry as a basename only,
  so the host log keeps it after the guest is destroyed.
- **Related changes.**
  - Accepted the reviewed new collector hash.
  - Fixed the stale readiness producer pin from `9b42d675d`. That change was a
    helper-only refactor, identical for well-formed configs, and the stale pin had
    left unused-reservations red on main.
  - Fixed a fork/exec race in the Hub fixture (2/12 flake).
- **Status mitigated.** The retention mechanism and the detection blind spot are
  reproduced and fixed. The original writer's identity stays an observability gap
  until the new detail line captures a recurrence.
- **Follow-up.** The resume tool should journal the pending it accepts (sha and
  content).
- **At 10k agents.** Each controller does one `/proc` scan per second for at most
  120 s, with no shared resource.

## Human feedback

None recorded.

## Reusable lesson

Wait for every sign that a workload is still quiescing (live writers as well as drift) inside one bounded drain, detect writers per thread rather than per leader, and log the refusal evidence to the host before the guest that holds it is destroyed.
