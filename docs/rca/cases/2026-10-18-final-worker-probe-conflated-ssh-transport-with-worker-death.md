---
id: 2026-10-18-final-worker-probe-conflated-ssh-transport-with-worker-death
date: 2026-10-18
title: Final autoscaler acceptance reported a worker dead when the controller SSH transport failed, and timed-out flyctl children were orphaned
surface: infra
component: cloudbench-fleet-autoscaler
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet worker_operational — one single-shot flyctl ssh probe whose transport failure (exit 1, output discarded) was read as a negative worker verdict at final acceptance; scripts/lib/cloudbench-inventory.sh fly_with_timeout — TERM to the wrapper shell reparented a TERM-surviving flyctl before KILL
symptoms:
  - "mandatory autoscaler worker became unhealthy before final acceptance"
  - "Error: tunnel unavailable: Error contacting Fly.io API when probing \"personal\": timed out (context deadline exceeded)"
  - "[warn] FLY_COMPLETION_TIMEOUT shell_pid="
  - "orphaned flyctl ssh console / flyctl ssh sftp put processes with ppid 1 after the fleet exited"
  - "runtime evidence is incomplete; failed result retained while disposable resources are retired"
tags:
  - cloudbench
  - autoscaler
  - flyctl
  - ssh
  - fly-agent
  - wireguard
  - orphan-process
sources:
  - fleet run 20261018-073801-19001 (campaign job r001-j0068, shard-03 controller 84ee290f49d6d8, worker 827446c7710178)
  - task grep-agent-trajectories-isolation
  - agent 46e6a8d3-adbe-4aa5-b354-d92eb0f0b9ba
  - commit 373585f80c006fc53412c8f9ccc0c7335e32f32a (source under test)
repro: agents/benchmarks/worker_capacity_loop_test.py::test_autoscaler_runtime_handoff_capacity_final_health_separates_transport_from_worker_death and agents/benchmarks/cloudbench_campaign_inventory_test.py::test_campaign_inventory_timeout_reaps_native_child_that_survives_term
status: fixed
---

## Problem

The 100-copy sharded diagnostic (4 controllers × 25, released 07:46:15Z
2026-10-18) recorded job `r001-j0068` (`grep-agent-trajectories-isolation`,
shard-03) as a failed controller: `❌ [grep-agent-trajectories-isolation]
mandatory autoscaler worker became unhealthy before final acceptance`,
controller exit 1, wall 1,588 s. Because `AUTOSCALER_FAILURE=1`, the fleet's
`_batch/lifecycle.json` stayed `failed`, and the campaign kept the job as
`retry_blocked: terminal result or release remains unverified`.

The task itself had already reached a genuine terminal verdict: `FAILED`,
`Timeout after 852s (task timeout=844s) … Agent status: PAUSED`, 14 LLM calls,
Hub outcome acknowledged at 08:02:35Z. That task failure is a separate matter.
This case covers the autoscaler verdict and leaked processes only.

At 08:38Z on the controller (read-only `ps`), three `flyctl` clients were still
alive with ppid 1 in the fleet's process group 19001. All three targeted worker
827446c7710178, which had been destroyed at about 08:04Z: PID 755 `flyctl ssh
console … pgrep -f 'python [w]orker.py' … /health` (started 07:56:27), PID 4721
`flyctl ssh sftp put … cloudbench-sync-deps.sh` (07:49:41) and PID 18956 `flyctl
ssh sftp put … cloudbench-worker-evidence.py` (07:50:27). Each had run inside
`fly_with_timeout 20`.

## Diagnosis

Timeline (controller files plus `/home/rose/.fly/agent-logs`):

- 07:49:08 worker created; 07:49:11 the first staging `ssh console` found no
  agent on the default socket and started the default background agent PID
  29400. The shared relay's isolated agent PID 1071 was already running.
- 07:49:33–07:52:05 staging took 10 attempts: 4 × `tunnel unavailable … probing
  "personal"` and 5 × `FLY_COMPLETION_TIMEOUT`. At 07:50:27 the evidence-helper
  upload printed `28357 bytes uploaded` and then never exited (PID 18956).
- 07:56:28 agent connection `#d6` for PID 755 got `ok` to `[…2917:2]:22`. It was
  never dropped. The readiness loop retried, and the worker became ready at
  07:57:06.
- 08:03:32 `autoscaler.completed-after-child`. Final acceptance then ran
  `ready_workers_operational`. The only default-agent client in 08:03:32–08:03:48
  was `#175/#176`: `establish personal` at 08:03:33, then `err Error contacting
  Fly.io API when probing "personal": timed out` at 08:03:38. That is the
  client's pre-connect tunnel probe. No `connect …:22` followed, so the probe
  never reached the worker. Only one other client used this agent: the
  readiness loop for polar-odysseys-e1184e98c9a0's worker 83dd001f7040e8. It
  finished with a successful 87 ms session (`#173`, 08:02:53) and did not use
  SSH again until its 08:05:19 capture. flyctl exits 1 with that error, and
  `worker_operational` discarded the output (`>/dev/null 2>&1`) and returned 1.
  The fleet then printed "became unhealthy".
- 08:03:48–53 the worker-evidence capture (`#177–#179`) failed with the same
  error (`capture.log` written at 08:03:53), so runtime evidence was missing as
  well.

Rungs:

1. The final verdict came from a transport failure, not a worker observation.
   The probe uses one exit status for both "the remote shell ran and pgrep or
   /health failed" and "flyctl never reached the worker". It runs once, and
   final acceptance treats any nonzero result as worker death. The readiness
   loop survives the same failure only because it re-polls every 5 s.
2. The transport was degraded because of how the controller was configured,
   not because of the worker. Each controller ran two flyctl agents that shared
   the one `wire_guard_state` peer in `~/.fly/config.yml`
   (`interactive-84ee290f49d6d8-…`): the relay's isolated agent and a default
   agent spawned by fleet `ssh` and `sftp` calls. The same pattern showed on all
   four controllers. The relay agent logged no `context deadline exceeded` dials
   until about 10 s after the default agent started, then logged them every
   minute while the default agent carried traffic:

   | Controller | Default agent start | First relay dial deadline | Default-agent probe failures |
   | --- | --- | --- | --- |
   | shard-00 | 07:54:50 | 07:55:00 | 27 |
   | shard-01 | 08:11:25 | 08:11:35 | 5 |
   | shard-02 | 07:57:52 | 07:58:02 | 14 |
   | shard-03 | 07:49:11 | 07:49:22 | 24 of 101 |

   This rung is owned by the guest-collection lane
   (`fix/shard-guest-collection`: export the relay agent socket to every
   campaign child). It is not reproduced here because a real WireGuard peer is
   required.
3. Orphans: on timeout, `fly_with_timeout` sent TERM to the native children and
   to its wrapper subshell, then escalated to KILL only if the wrapper job was
   still running. The wrapper died from TERM at once, so the
   `flyctl` client, which survives TERM because a blocked SSH session never
   observes its cancelled context, was reparented to init. The KILL escalation
   was then skipped. An idle established TCP stream over the userspace tunnel to
   a destroyed Machine never ends, so these processes, and their default-agent
   sessions, live indefinitely.

Reproductions (both fail on 99a083bef and pass on the fix):

```
cd agents && PYTHONPATH=. venv/bin/python -m pytest -q \
  benchmarks/worker_capacity_loop_test.py benchmarks/cloudbench_campaign_inventory_test.py \
  -k 'final_health or timeout_reaps_native_child'
# pre-fix: 3 failed
#  {'transport-then-healthy': (1, {'827446c7710178': 1})} != (0, {…: 2})
#  {'transport-persistent': (1, …: 1)} != (75, …: 3)
#  AssertionError: native child outlived its fly_with_timeout deadline   (×2)
```

Archive searches: "mandatory autoscaler worker became unhealthy before final
acceptance" and "fly_with_timeout flyctl orphan ssh console hang tunnel
unavailable probing personal". This case is related to
`2026-08-19-refresh-deps-sftp-tunnel-timeout-aborts-fleet`, which hit the same
`tunnel unavailable` transport error. That fix was a per-call-site retry, so
this other single-shot consumer was still exposed. It is also related to
`2026-08-03-post-child-worker-ledger-contention-treated-terminal`, which turned
another transient post-child observation into a terminal failure. Neither is a
recurrence of the same boundary.

Golden references: `codex/codex-rs/utils/pty/src/process_group.rs:293`
(`kill_child_process_group`, test `core/src/exec_tests.rs:1383`) and
`claude-code-src/src/utils/ShellCommand.ts:340` (`treeKill(pid, 'SIGKILL')`).
Both SIGKILL the native child or tree on timeout directly; they do not rely on
the wrapper dying first. `codex-rs/core/src/exec.rs:792-819` (`timed_out`) and
`ShellCommand.ts:302` (`interrupted`) both report "could not complete or
observe" separately from the command's own exit code.

## Solution

- `fly_with_timeout`: on deadline, TERM only the wrapper's native children and
  keep the wrapper alive, so `-P "$pid"` still names exactly this invocation's
  children. Wait up to 2 s, KILL any children still running, then KILL the
  wrapper only as a last resort. The completion and EOF contract, the markers
  and return codes 142/1 are unchanged. This prevents sibling orphans from every
  `fly_with_timeout` caller (staging uploads, readiness probes, cleanup).
- `worker_operational` now has three results. The remote shell prints
  `cloudbench-worker-health=unhealthy` when pgrep or /health fails (exit 1).
  rc 0 means healthy. A failure with no remote verdict returns 75 (transport).
  Every failed probe's raw output goes to `worker-<id>.health.log` instead of
  `/dev/null`. `ready_workers_operational` re-observes only rc 75, at most 3
  times per worker, 5 s apart (`CLOUDBENCH_FINAL_WORKER_HEALTH_ATTEMPTS` and
  `CLOUDBENCH_FINAL_WORKER_HEALTH_RETRY_SECONDS`). Final acceptance
  (`mandatory_worker_health_acceptable`) still fails closed. A
  worker-reported failure says "became unhealthy". Persistent transport failure
  says "health unobservable … controller SSH transport failed". The acceptance
  rule is not loosened: a worker counts only when it is observed healthy.
- The multi-workstream fake Fly now emits the remote verdict for a not-ready
  worker, matching the real command.
- Scale: the added work is at most 2 extra SSH probes per ready worker, and
  only after a transport failure at final acceptance. Nothing new runs per
  poll, and the change is O(1) per worker.

## Human feedback

The coordinator directed that the dual-agent transport fix belongs to the
guest-collection lane, and that this lane should not edit
`bind_shared_relay` or the env export, and should not loosen acceptance rules
without evidence.

## Reusable lesson

Treat a failed remote-shell transport as a missing observation. Re-observe it
within a bound. Only a verdict printed by the remote side can prove a worker
unhealthy, and a timeout must KILL its native child before the wrapper exits.
