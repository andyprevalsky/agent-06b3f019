---
id: 2026-10-20-sharded-host-owner-death-left-live-campaign-without-global-stop
date: 2026-10-20
title: A host service restart killed the sharded operator and runners, leaving 60 live guests with no global infra stop and no supported reattach
surface: infra
component: original600-sharded-operator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-original600-supervisor.py validate_snapshot/validate_shard — a shard supervisor defaulted its infra threshold to 30 regardless of group_total, so the only stop that matched the 5% rule lived in the host coordinator (cloudbench-shard-coordinator.coordinate), whose state had no adoption path (runner run() only accepted a new output; --resume-bound-launch only an absent output)
symptoms:
  - boxes.dev service restart killed scripts/run-original600-controller.py --run and both scripts/cloudbench-original600-runner.py processes after the global start barrier released
  - coordination.json frozen with released_at set, finished_at null, infra_true 0, shards pids dead
  - shard-status.json observed_at stops advancing; scripts/run-bench scorecard <admission-dir> freezes at "COMPLETED 0/60" while original600-status.py shows 9 PASS
  - shard supervisor infra threshold 30 for a 30-job shard of a 60-job group (global stop 3/60 not enforced)
  - "Nothing supported can reattach the host runner or coordinator to a live sharded campaign"
tags:
  - cloudbench
  - original600
  - sharded-operator
  - infra-threshold
  - host-death
  - adoption
  - scorecard
sources:
  - benchmark run original600-1792470090920184153 (controllers 843292f2d97368 / 08001dea711098), host death ~2026-10-20T04:58Z
repro: scripts/tests/cloudbench-shard-coordinator.test.py (HostDeathAdoption), scripts/tests/cloudbench-original600-supervisor.test.py (Shard.test_shard_supervisor_enforces_the_group_threshold_without_a_host)
status: fixed
---

## Problem

Polar batch 1 (admission `original600-1792470090920184153`, 2 shards × 30 jobs,
`scheduled_total` 60, early stop enabled) released its global barrier at
04:44Z. At about 04:58Z a boxes.dev service restart killed the local sharded
operator. That operator ran `--run` under `setsid nohup`. The restart also killed
both shard host runners and their gates. The guests on Fly kept running.
Evidence from the admission directory:

- `coordination.json` still had `released_at` 1792471441.49, `finished_at`
  null, `infra_true` 0, and runner PIDs 585518 and 585975, which were gone.
- `shard-00/run/shard-status.json` was last written at 04:57Z, the last PROBE
  from the dead runner.
- The scorecard froze at `COMPLETED 0/60`. Meanwhile, `original600-status.py`
  read the guest directly and showed 9 PASS.

There was no supported recovery. `runner run()` refuses an existing output.
`--resume-bound-launch` covers only an absent output. The dead-owner route
documents stop by barrier ABORT, then cleanup. The global 5% stop (3/60), Hub
and barrier delivery, and the exact supervisor TERM path all lived only in the
dead host processes.

## Diagnosis

Critical path for the global stop: guest supervisor `fold()` →
`.infra.json` → host runner PROBE (Fly exec) → `shard-status.json` → host
coordinator sums shards → SIGTERM runners → runner `request_term` → supervisor
TERM → campaign parent. Each hop after `.infra.json` is a host process.

1. First bad: `validate_snapshot` folded each shard with
   `shard.get('infra_threshold', 30)`. `bound_shard` never binds that field,
   so every shard used 30 whatever its `group_total`. For a 30-job shard of a
   60-job group, the guest could never stop on its own. Host liveness was the
   only thing enforcing the user's fixed 5%-of-scheduled rule.
2. Why the host death was terminal: the coordinator journal and runner outputs
   held the full owner identity (`caller.json` pid/birth/gate, authority hash,
   `controller.identity.json`, supervisor identity path, release ID). No code
   could bind a new owner to them, so the death could not be recovered.
3. Why the launcher did not protect it: `setsid nohup` creates a new session
   but stays in the service's cgroup. The service restart killed the whole tree.
   That is outside the code. The durable guard is adoption, not a launcher trick.

Proof (both new tests, run on an `origin/main` b61d9d0da tree with the new test
files copied in):

```
$ python3 scripts/tests/cloudbench-original600-supervisor.test.py Shard.test_shard_supervisor_enforces_the_group_threshold_without_a_host
AssertionError: Tuples differ: (0, 'natural') != (7, 'term')
- (0, 'natural')
+ (7, 'term') : 3/60 of the group stops this shard; 2/60 continues
FAILED (failures=1, errors=5)
$ python3 scripts/tests/cloudbench-shard-coordinator.test.py HostDeathAdoption
KeyError: 'adoption_binding'
TypeError: coordinate() got an unexpected keyword argument 'adopt'
KeyError: 'adopt_live_sharded'
FAILED (errors=3)
```

The adoption test kills the recorded runner and gate processes, which is the
service restart. Two real fake-supervisor processes keep running, with infra
2 and 1 (3/60 only across shards). The dead runner's `shard-status.json` is
frozen at 0 PASS.

## Solution

- **Host-independent stop:** `group_infra_threshold(shard)` returns an explicit
  `infra_threshold`, or else `ceil(group_total/20)`. It is used by the
  supervisor (`validate_shard`/`validate_snapshot`), the runner `shard_shape`, and
  `original600-status.py`. One shard reaching the group threshold implies the
  group reached it, so the stop is never earlier than the global rule. 600
  scheduled jobs still gives 30.
- **Re-adoptable observation and stop authority:**
  - `cloudbench-original600-runner.py --adopt-live <out>` refuses unless the
    recorded runner and gate PID/birth are gone. It also refuses when no
    `terminal.json` exists, or when another adopter holds `adoption.lock`.
  - It writes `adoption-NN.json`, then resumes PROBE, `shard-status.json` (so the
    scorecard resumes live counts), and barrier delivery.
  - It sends one never-replayed supervisor TERM, reusing `supervisor-term.intent.json`.
  - It exits when the supervisor reports JOINED. It never runs cleanup, which
    stays with the dead-owner route.
- **Coordinator adoption:** `coordinate(adopt=journal)` continues the original
  journal, release ID, decision and clocks. It records `adoptions[]` with the
  previous PIDs and keeps the fixed scheduled total and policy. It refuses a
  finished journal, and also refuses a live recorded coordinator.
  `run-original600-controller.py --adopt-live <admission> [--check]` binds all
  shards before spawning any. Fresh journals now record `coordinator`
  pid/birth for future adoption checks.
- The `--check` run against the live admission bound both dead owners,
  machines 843292f2d97368/08001dea711098, and wrote nothing.

10k-agent behavior: one adopter per controller, the same 5 s exec PROBE as the
original runner. It does no per-job or per-agent work and holds no shared lock
beyond the per-output adoption lock.

Golden reference: `claude-code-src/src/bridge/bridgeApi.ts:170-177` re-registers
with the prior durable `environment_id` so the backend reattaches instead of
creating a new environment. `claude-code-src/src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:272`
leaves a live tmux session for reattach. The fix follows the same pattern:
reattach to the existing durable identity rather than recreate. The
openclaw/hermes/codex clones were not present locally.

Not fixed here: the launcher still runs inside the service cgroup.
`--adopt-live` is the recovery. Its docs say to launch it under a
session-surviving process manager. Live Hub group publication still runs only
at start and finish.

## Human feedback

The parent asked that any re-adopt fix bring `scripts/run-bench scorecard` back
to live counts (it froze at "COMPLETED 0/60" while `original600-status.py`
showed 9 PASS). The regression asserts the scorecard goes from 0 to 17 PASS
from the adopter-written `shard-status.json`.

## Reusable lesson

Every live-run safety stop must hold on the remote side or be re-adoptable from durable owner receipts, because host liveness cannot carry it alone.
