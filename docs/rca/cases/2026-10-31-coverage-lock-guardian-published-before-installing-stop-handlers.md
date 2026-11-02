---
id: 2026-10-31-coverage-lock-guardian-published-before-installing-stop-handlers
date: 2026-10-31
title: Coverage lock guardian published "acquired" before installing its SIGTERM handler, so an early owner SIGTERM killed it without reaping registered process groups
surface: back-end
component: coverage-process-lock
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/coverage-process-lock.py main() wrote status "acquired" and only then called signal.signal(SIGTERM, stop); the owner contract sends SIGTERM as soon as it reads "acquired", so a guardian descheduled in that window died under the default disposition and terminate_registered_process_groups never ran
symptoms:
  - "AssertionError: surviving descendant was not reaped after leader exit"
  - "FAIL  coverage-process-registry.test.ts"
  - "1/349 unit test file(s) failed."
  - "guardian exited -15 on a SIGTERM that arrived while it published its lock"
tags:
  - backend-coverage
  - process-group
  - signal-handler
  - flake-under-load
  - deploy-gate
sources:
  - PR #1660 deploy round 3 lane backend-coverage-blackbox (run 20261031-205545-975730, head c274b9e62; fixture traceback in that run's back-end/coverage/units.log)
  - commit c274b9e62
repro: back-end/src/tests/unit/coverage-process-registry.test.ts (scenario "coverage-early-term-": FIFO-parked status publication + SIGTERM; and the leader-exit scenario now asserts the guardian's exit status)
status: fixed
---

## Problem

Deploy 12 (PR #1660, head c274b9e62) round 3, lane `backend-coverage-blackbox`,
unit pass: `coverage-process-registry.test.ts` failed in 4339 ms with the embedded
fixture raising `AssertionError: surviving descendant was not reaped after leader
exit`. The same bytes passed in round 1 and the PR touches no back-end file. The
host ran four blackbox shards, six concurrent unit files under V8 coverage, the
agents coverage lane, the smoke lane and the cloudbench controller at the time
(receipt `host_peak.load1_peak` 11.69 on 8 cores).

Runtime evidence that bounds the mechanism:

- The failing scenario sends SIGTERM to the guardian the instant the status file
  reads `acquired`, calls `guardian.wait(timeout=10)` (which returned, so the
  guardian was gone within 10 s) and then polls `os.kill(child_pid, 0)` for 2 s.
- Per-scenario timing of the unchanged file (unloaded): scenarios 1–3 take
  1.83 s, of which scenario 3 contains an unconditional 1.5 s `ps` shim sleep;
  the leader-exit scenario takes 0.26 s and the guardian returns ~50 ms after
  SIGTERM. A 4339 ms total therefore means the guardian exited within ~0.4 s of
  SIGTERM in the failing run — not after the 5 s TERM wait or the SIGKILL
  escalation — while the descendant stayed signalable for the full 2 s poll.
- Every fast exit path that leaves the group alive was enumerated: identity
  skip (sentinel gone or `/proc` read failure), external kill of the guardian,
  or the guardian dying before running cleanup. The sentinel ignores SIGTERM;
  `ps -e -o pid= -o pgid=` never omitted a live sleeper in 2002 scans under
  load 12; no concurrent unit test signals anything but its own pids/groups;
  no subreaper exists in the unit-pass ancestry; sibling lane logs record no
  sweep or kill in 21:04–21:10Z.

## Diagnosis

`coverage-process-lock.py main()` did, in order: `os.setsid()`, take the flock,
write the owner pid into the lock file, `write_status(status_path, "acquired")`,
and only then `signal.signal(SIGTERM, stop)` / `signal.signal(SIGINT, stop)`.
Both owners (`run-coverage.sh:acquire_process_lock` and the unit fixture) poll
the status file and treat `acquired` as "the guardian is ready", and the fixture
sends SIGTERM immediately. If the guardian is descheduled between the status
write and `signal.signal` — microseconds unloaded, routinely longer than the
owner's 20 ms poll under the sharded unit pass's CPU contention — SIGTERM lands
under the default disposition: the interpreter dies with `-15`, the `with
lock_path.open(...)` block never reaches `terminate_registered_process_groups`,
and the registered group (identity sentinel plus the 30 s descendant) survives.
The fixture then reports the downstream symptom, "surviving descendant was not
reaped after leader exit", because it discarded the guardian's exit status.

Proof (same guardian bytes, same fixture steps, `/var/tmp` scratch replica):

- Natural race: 576 iterations under a load-12 burst, 0 failures (the window is
  microseconds; the deploy hit it once across many rounds).
- Controlled schedule: delaying only the guardian's `signal.signal(SIGTERM, ...)`
  call by 0.3 s via a guardian-scoped `sitecustomize` reproduced the identical
  assertion 3/3 with `guardian_rc=-15`, `guardian_took=0.001s`, sentinel and
  descendant both alive and untouched.
- Parking the guardian inside `write_status("acquired")` with a pre-filled FIFO
  as the status sink and reading `/proc/<pid>/status` gave `SigCgt=0x2`:
  only Python's default SIGINT handler, no SIGTERM handler, while the lock was
  already held and published.

Step 5a ladder: Why could an owner's SIGTERM kill the guardian? Because the
handlers were installed after the publication the owner keys its SIGTERM on.
Why was that possible? The guardian's readiness contract ("acquired" means it
owns the lock and will reap on TERM) had no test that delivered TERM at the
publication boundary; the only test observed TERM handling after an unbounded
scheduler gap. The next rung ("owners should not signal immediately") moves the
fix to the wrong layer and leaves `run-coverage.sh` with the same gap. Stop.

## Solution

`back-end/scripts/coverage-process-lock.py`: install the SIGTERM/SIGINT stop
handlers immediately after `os.setsid()`, before the lock attempt and before any
status publication. A TERM that now arrives at any observable point sets
`stopping`, the wait loop exits at once, and registered groups are terminated.
No behaviour change for the blocked-lock path (`73`) or the normal lifetime.

`back-end/src/tests/unit/coverage-process-registry.test.ts`:

- The leader-exit scenario asserts `guardian.wait(timeout=10) == 0`, so a
  guardian that dies instead of reaping is reported as such
  (`guardian exited -15 instead of reaping its registered groups`), closing the
  observability gap that made this failure look like a slow reaper.
- New deterministic regression: the status sink is a FIFO whose buffer is
  pre-filled, so the guardian parks inside `write_status("acquired")`; the test
  waits for the lock file to name it as owner, sends SIGTERM while the guardian
  is parked, drains the FIFO, and asserts exit 0 plus a reaped descendant. On
  the pre-fix bytes it fails every run with `guardian exited -15 on a SIGTERM
  that arrived while it published its lock`; on the fixed bytes it passes
  (5/5 alone, 1/1 under a load-12 burst). No timing, no injection, portable
  (`mkfifo` + lock-file observation; no `/proc`).

Siblings prevented: `run-coverage.sh:release_process_lock` and
`test-db-run-lock.sh` send the same `kill` right after reading `acquired`; an
interrupted coverage run during lock acquisition no longer leaves a guardian
dead with its registered groups unreaped. 10k-agent behaviour: not applicable
(test/deploy tooling; one guardian per coverage shell).

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Install a long-lived helper's stop handlers before it publishes the readiness its owner keys a signal on, and make the owner assert the helper's exit status rather than inferring it from downstream state.
