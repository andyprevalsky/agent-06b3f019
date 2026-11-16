---
id: 2026-11-07-boxes-session-scope-kill-reaped-setsid-campaign-controller
date: 2026-11-07
title: A boxes.dev session hard-dispose SIGKILLed a setsid campaign controller because it still lived in the agent session's cgroup scope
surface: infra
component: run-bench-launch
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: campaign launch placement — `setsid bash -c "... exec scripts/run-bench ..." &` (and scripts/run-bench, which offered no durable launch) left the controller in /boxes_workload.slice/boxes-workload-<id>.scope, the Claude session's cgroup, which the boxes.dev daemon kills as one process family
symptoms:
  - "A boxes.dev service restart stopped these background commands"
  - campaign launch log ends mid-line with no "controller received TERM"; all 16 job controllers, agent link servers and the shared `flyctl agent` gone together
  - "claude broker dispose_start ... mode=hard" then "process_exit ... signal=SIGKILL" and "process_family_terminated ... terminated_process_count=156"
  - "random: crng reseeded due to virtual machine fork" followed by a two-hour journal gap and "chronyd: Forward time jump detected!"
tags:
  - cloudbench
  - campaign
  - boxes-dev
  - cgroup
  - systemd-run
  - setsid
  - devbox-suspend
  - launcher
sources:
  - benchmark run campaign-20261106-224723-821219 (descend cluster I-21; launch log /var/tmp/descend-e5/b3-e14-launch.log; host journal 00:12:13Z suspend, 02:21:09Z resume, 02:21:18Z hard dispose)
  - memory:boxes-session-restart-kills-background-lanes
  - memory:gate-passes-launch-as-transient-service
repro: scripts/tests/run-bench-durable-service.test.py (DurableLaunchSurvivesSessionScopeKill, DurableLaunchContract)
status: fixed
---

## Problem

A 19-task `-k 3 --concurrency 16` cloud campaign was started from
`/var/tmp/descend-e5/launch.sh` as
`setsid bash -c "... exec scripts/run-bench ..." > log 2>&1 < /dev/null &`. The
controller, all 16 job controllers, the agent link servers and the shared
`flyctl agent` died together. The launch log ended with no
`controller received TERM` and no cleanup traps ran, so the cloud Machines were
left for exact-owner recovery. There was no reboot (uptime 42 h), no kernel OOM
and no `/run/boxes-memory-terminations.jsonl` record. The harness reported "A
boxes.dev service restart stopped these background commands".

The log's last write (00:11:39Z) is not the kill time. The last campaign file
writes were at 00:12:13.5Z, including a half-finished atomic replace
(`shared-inventory/machines.json.tmp.825383.29000`).

## Diagnosis

Journal timeline (UTC):

1. 00:12:13.5–00:12:17.9: the VM paused. The next kernel line,
   `random: crng reseeded due to virtual machine fork`, carries the frozen
   clock. Nothing is logged until 02:21:09, then chronyd reports
   `Forward time jump detected!`. The processes were frozen, not killed. This
   matches [[devbox-suspend-stalls-unattended-controllers]].
2. 02:21:17: on resume the daemon updated (`install ... wrappers/claude`) and
   `Stopping boxes-daemon-supervisor.service`. The sprite daemon logged
   `shutdown signal=SIGTERM`, then for this session
   `claude broker dispose_start ... mode=hard pid=2373419`.
3. 02:21:18.68: the daemon logged `process_exit ... signal=SIGKILL` and
   `process_family_terminated ... terminated_process_count=156`, and
   `boxes-workload-0c75d3874e3f4aea95ff989b2eb0d9f5.scope: Deactivated
   successfully` appeared with no systemd `Stopping` line. The daemon killed
   every process in the session's cgroup scope itself. SIGKILL cannot be
   trapped, which is why no `controller received TERM` was written.

Why a setsid'd process counted as family: setsid processes are reparented to
PID 1 (current examples: PPID 1 with their own session) but stay in the
caller's cgroup. Every process started from an agent Bash tool is in
`0::/boxes_workload.slice/boxes-workload-<id>.scope`, the scope boxes.dev
created for that `claude` process. A cgroup-wide kill ignores session and
process-group boundaries.

Hard and graceful disposes behave differently: at 02:26:17 the same thread's
next session was disposed with `mode=graceful`. Its claude process exited
with 143, and setsid processes in that scope (the owner's recovery jobs)
survived. An unrelated Codex session scope also survived the 02:21 restart.
So the earlier memory "setsid survives Claude-session restarts" holds only for
graceful disposes and for kills by process group or session. A daemon-restart
hard dispose takes the whole cgroup.

Step 5a ladder:

- Why 1: the controller ran inside the session scope that was hard-killed.
- Why 2: the only documented detach practice (`setsid`/`nohup`) changes the
  session and process group, never the cgroup.
- Why 3: `scripts/run-bench` had no launch path that leaves the caller's
  cgroup, and the runbook did not say that agent-session cgroups are
  disposable. Each operator hand-rolled a launcher, and the known working
  shape (a transient system service: memory
  [[gate-passes-launch-as-transient-service]]) was never in the CLI.
- Why 4 would be the boxes.dev daemon's dispose policy. That is third-party
  configuration we do not own, so we stop at Why 3.

The local reproduction is
`DurableLaunchSurvivesSessionScopeKill.test_setsid_control_dies_with_the_session_scope`.
It runs a launcher inside a throwaway `systemd-run --scope` with an anchor
process standing in for the agent CLI, then
`systemctl kill --signal=SIGKILL <scope>`. The setsid controller dies with the
scope every time. On base d5fafdc1ec, the durable-path tests fail
(`❌ Unknown flag: --durable` / `--durable-log`; 3 FAIL + 1 ERROR).

## Solution

`scripts/run-bench --durable [--durable-log FILE]` re-executes the exact command
as `sudo -n systemd-run --unit=run-bench-<utc>-<pid> --uid/--gid` with:

- `KillMode=process`, `TimeoutStopSec=2h`, `WorkingDirectory=<caller dir>`
- output appended to the log, which is pre-created owned by the caller
- explicit `PATH`/`HOME` plus forwarded `CLOUDBENCH_*`, `RUN_BENCH_*` and
  other launch knobs; secret-like names are skipped with a warning
- `$` escaped as `$$` (systemd expands `$VAR` in ExecStart)
- an `ExecStopPost` exit marker appended to the log

Exec semantics are preserved: the ordinary fleet path gets `--foreground`
inside the unit, so MainPID is the controller (the campaign and sharded
operator already exec). `systemctl stop` therefore sends TERM only to the
controller, whose traps own cleanup.

The launcher prints unit, MainPID, cgroup and log. It fails loudly on a startup
exit and refuses `--wait`/`--detach`/`--foreground` and logs directly inside a
sticky directory (systemd opens the log as root; `fs.protected_regular`
refuses). Without systemd-run or passwordless sudo, it prints
`DURABLE LAUNCH UNAVAILABLE ... NOT restart-durable` and falls back to setsid.

Sibling failures prevented: long `--recover-stale-owner` recoveries,
fleets and sharded operators launched from agent sessions (the 2026-10-20
sharded-operator host death,
[[2026-10-20-sharded-host-owner-death-left-live-campaign-without-global-stop]],
had the same trigger with `setsid nohup`). 10k-agent behavior: one transient
unit per launch, with no shared state added.

The regression `scripts/tests/run-bench-durable-service.test.py` is registered
as structural gate `run-bench-durable-service` and listed in deploy.md Step 4s.
Its stubbed contract tests always run. The live scope-kill tests run when
systemd is PID 1 and passwordless sudo is available. It passed 5 consecutive
runs with unchanged test code.

## Human feedback

None recorded.

## Reusable lesson

On boxes.dev, a process started from an agent session stays in that session's cgroup no matter how it is detached; launch anything that must outlive the session with `scripts/run-bench --durable` (a transient system service), never `setsid`/`nohup` alone.
