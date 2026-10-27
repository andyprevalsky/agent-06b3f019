---
id: 2026-10-20-controller-gate-flyctl-machine-run-unbounded-after-machine-id
date: 2026-10-20
title: Controller gate waited 17 min on a flyctl machine run that blocked after "Machine started"
surface: infra
component: run-cloudbench-controller-gate
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-cloudbench-controller-gate — `flyctl machine run --detach ... 2>&1 | tee "$RUN_LOG"` ran in the foreground with no deadline, so the gate waited for flyctl to exit even after the Machine ID was in the log
symptoms:
  - flyctl secrets list hangs before allocation
  - "Machine started, you can connect via the following private ip"
  - flyctl machine run --detach in futex_wait for ~17 min after printing Machine started
  - gate silent between machine-create.intent.json (00:35:57Z) and create.private.log (00:53:18Z)
  - "✅ machine <id> started; waiting up to 7200s" printed 17 min after the Machine started
tags:
  - cloudbench
  - controller-gate
  - flyctl
  - unbounded-call
  - original600
sources:
  - fleet run original600-1792456540111088404 shard-00 (gate pid 2560533, flyctl pid 2567131, Machine 8d99dd7be69478)
repro: CLOUDBENCH_TEST_GATE_SOURCE=<pre-fix gate> python3 scripts/tests/cloudbench-controller-gate-flyctl-bounds.test.py (fails: "gate launch block still blocked after 30s"); the same command on the fixed gate passes
status: open
---

## Problem

In live run `original600-1792456540111088404`, shard-00's gate wrote
`export/machine-create.intent.json` at 00:35:57Z. The flyctl output it copied
after the call (`export/create.private.log`) is dated 00:53:18Z. That output
already shows `Machine ID: 8d99dd7be69478` and `Machine started`. For the 17
minutes in between, the local flyctl (pid 2567131) was blocked in `futex_wait`.
The remote controller was healthy the whole time. flyctl eventually exited by
itself and the gate went on, but the shard lost 17 minutes. A TERM sent to the
gate during that time would also have been deferred: bash runs a trap only after
the foreground pipeline finishes.

## Diagnosis

1. The gate runs `flyctl machine run ... --detach 2>&1 | tee "$RUN_LOG"` as a
   foreground pipeline. Nothing bounds it. `tee` waits for EOF from flyctl.
2. The gate needs only the `Machine ID:` line from that output. It already
   tolerates a non-zero flyctl exit (flyctl's own start wait is shorter than a
   cold image pull), and the real readiness wait is the log-poll loop after it.
3. The deepest cause we own: the gate's provider CLI calls had no deadline.
   There were eight unbounded calls in total: the image lookup, workspace volume
   creation, Machine run, log reads, the state poll, two step-log sftp reads,
   and the fetched-marker ssh. Only the export sftp and the cleanup destroy were
   bounded. Each one can stall the controller path the same way.
4. Why flyctl blocked inside the Fly API is a third-party problem. It is the
   same stall class as today's warm-donor resize i/o timeout. We have not
   reproduced it locally and do not own it.

Local repro: a fake flyctl prints the real `Machine ID` / `Machine started`
lines and then blocks. The gate's actual launch block, taken from its source,
is run against it. On origin/main the block is still waiting after 30 s
(`gate launch block still blocked after 30s`), and TERM does not end it either.
On the fix it returns within about 2 s with the Machine ID.

## Solution

- `fly_machine_run_bounded`: runs flyctl as the gate's own background child.
  It streams the output and writes it to the same log the caller reads. While no
  Machine ID line has appeared there is no deadline, because stopping flyctl
  could leave a Machine whose ID was never read. That keeps the call fail-closed.
  After the ID line, flyctl gets `CLOUDBENCH_GATE_RUN_AFTER_ID_S` (600 s) to
  finish starting, and `CLOUDBENCH_GATE_RUN_AFTER_START_S` (30 s) after
  `Machine started`. When a deadline passes, only that pid is signalled: TERM,
  then KILL after 5 s.
- `fly_bounded <s>`: the same exact-child bound for every other gate flyctl
  call. On timeout it returns 124, so each caller's existing `|| true`,
  empty-state or fail-closed handling still applies. Cleanup on EXIT stops an
  in-flight flyctl child. A TERM now ends the launch promptly.
- Related cases: `2026-07-13-unbounded-flyctl-ssh-console-hangs-on-stale-git-lock`
  and `2026-10-18-final-worker-probe-conflated-ssh-transport-with-worker-death`
  (the same class in `run-bench-fleet`; these gate calls had been missed).
- Sibling Python scripts on the controller path (`run-original600-controller.py`,
  `cloudbench-resume-controller-export.py` through `run_bounded`, the export
  sftp) were already bounded.
- Regression: `scripts/tests/cloudbench-controller-gate-flyctl-bounds.test.py`.
  It is registered in the `/deploy` structural gate registry (and in
  `scripts/test.sh`). It also checks that no unbounded flyctl call is left in
  the gate.
- Review follow-ups (combined deploy of #1550 and #1551). `fly_bounded` also
  runs inside `$(...)` and pipelines. There the parent's cleanup cannot see
  `FLY_CHILD_PID`, and the background flyctl ignores SIGINT. A Ctrl-C to the
  process group therefore left that flyctl running with no bound. Inside a
  subshell, `fly_bounded` now traps EXIT, INT, TERM and HUP and stops its own
  exact child. Separately, a signal during the post-ID window used to stop
  flyctl while `MACHINE_ID` was still empty, so the logged Machine was neither
  destroyed nor reported retained. Cleanup now recovers the ID from the run
  log. Both cases fail on the pre-fix gate (4 subtests) and pass in the same
  regression file.
- Second review round (PR #1558): the phase before the Machine ID had no
  deadline either. It now gets `CLOUDBENCH_GATE_RUN_BEFORE_ID_S` (default
  900 s). When flyctl stops or fails without printing an ID, the gate looks up
  the one Machine with the run's unique name (bounded `machines list`), fails
  closed, and cleanup destroys or retains that exact Machine. The run log is
  kept until the ID is read. `scripts/test.sh` auto-RCA mode now selects this
  suite when the gate script changes.
- 10k-agent behavior: there is one gate per controller. The change adds a
  0.2 s local poll while a flyctl call is running, and no per-agent work.

## Human feedback

The parent asked that the Machine-ID timeout keep the existing semantics, that
only the exact flyctl child be killed, and that the gate stay fail-closed when
no Machine ID appears.

## Reusable lesson

When a provider CLI call is needed only for a value it prints, start its
deadline once that value appears, stop only that exact child, and never put a
deadline before the point where the resource becomes recoverable.

## Recurrence — early app-environment verification lacked a native deadline (2026-10-27)

Polar k2 iteration4 at `56ad8146f3decdca1d3ff427eda9327cac4f52c0`
blocked before allocation in a read-only canary. The launch owner reported the
`run-bench-cloud --verify-secrets` child (1456644) waiting for `flyctl secrets
list -a navi-whisper-lux-bench --json` (1456787), alive for13m41s at22:46UTC
with an established API socket. Thirty scheduled members had no terminal
result or allocated Machine at that observation. These are parent/owner
observations; native socket cause is unknown. No task PASS or infrastructure
terminal classification is invented from this stall.

The owning boundary is `verify_app_environment`: its native command had no
deadline. The existing `_with_timeout` function was defined only after the
`--verify-secrets` early-exit branch. Thus that early verifier could not use it
without moving the shared definition. This is a recurrence of the same missed
native-call deadline class, at a different CLI entrypoint; the prior gate repair
did not cover this verifier.

The repair moves the existing native-child helper before the verifier,
keeps identical auth/app/JSON arguments and required-secret parsing, and applies
a default20-second read limit. That default matches this source's existing
native inventory-read limit. `CLOUDBENCH_APP_ENV_READ_TIMEOUT_SECONDS` can choose
another positive whole-second limit; zero/all-zero or malformed values are
refused before native dispatch. Native failure/timeout retains the original
read exit in the diagnostic. No setup, secret mutation, success fallback,
canary bypass, retry or task change is added.

Actual CLI fixtures reproduce a hung native read that ignores TERM. Baseline
fails the read budget and invalid-budget no-dispatch assertions (2FAIL/4PASS,
7.86s). The first bounded draft additionally exposed cancellation: the existing
helper handled signals only for guarded mutations, so TERM of the read wrapper
left an ignoring native child retaining stdout. That draft fails the new actual
CLI cancellation fixture. The shared handler now covers unguarded reads too,
retaining exact-child TERM, one-second grace, KILL and wait; guarded native
receipts are unchanged. The final nine fixtures pass in6.02s, including actual
CLI success, missing required names, malformed JSON, native exit17, timeout,
cancellation and invalid/zero/all-zero no-dispatch controls. The PID marker is
written only after the fake native installs TERM-ignore, so cancellation does
not accidentally test an ordinary terminating child. No provider is contacted.

Opened references: current Rose native timeout helper and inventory read budget;
OpenClaw `76ddbf697fc263cc1bf89fe3f4d08d96ed4a43af`
`src/infra/ocm-update-client.ts:189-195` bounds its JSON metadata CLI read, and
`src/process/exec.ts:46-90` supplies execution deadline and forced cleanup while
preserving rejection. Fly CLI `a1cf49a52b36fba66a2bf0907617bd5aadb8a727`
`internal/command/secrets/list.go:76-88,121-145` performs secret/machine/release
metadata reads before JSON output. Those facts support bounding the native
operation; they do not identify the server/socket cause.

Independent reviewer ph74rex3pescaywbxyjn3njr158h3pp9 returned GROUNDED for
exact full patch SHA256054614a02556e027340f08fd515aa99f7ad8a197b54db23476f24e82a021b7cc.
Applied verification: 11 owning CLI/helper cases passed in4.73s; campaign
environment10 in4.068s; staged boot29 in0.328s (6 unavailable-environment skips);
parallel mutation13 in7.062s; full cloudbench-env shell gate passed. Bash syntax
and RCA archive validation passed. An extra broad selector produced38 passes
and one unrelated nested-system-Python missing-httpx failure; the identical
case passed in0.41s with the existing venv first on PATH, no code change.
The case remains open for original native API
causality and unchanged cohort outcome evidence. The original
campaign's cleanup and next unchanged cohort remain parent/launch-owner work.
No provider mutation, paid run or deployment was performed by this RCA worker.
