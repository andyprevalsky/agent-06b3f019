---
id: 2026-09-10-detached-helper-inherited-controller-pipe
date: 2026-09-10
title: Detached Hub inherited the controller pipe after redirecting standard streams
surface: infra
component: cloudbench-detach
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/lib/cloudbench-env.sh cloudbench_detach_reexec preserved inherited descriptors above stderr across setsid and exec
symptoms:
  - top capability controller remained blocked in tee after terminal failure
  - agent_link_server retained fd 63 as a writer to the slice tee input pipe
  - "exact-owner recovery guard is held; retry after it exits"
  - "flyctl agent inherited fd10 on cloudbench-fleet-recovery-locks after recovery exited"
  - "fleet-infra-canary-preflight.transaction.lock inherited by hung flyctl secrets list"
tags:
  - cloudbench
  - fleet
  - detach
  - file-descriptor
  - pipe
sources:
  - commit fe99d86f6
  - commit 76f022579
  - fleet run capability-stability-20260910105116-2670724
  - fleet run Polar k2 I9 owner 49927b5b138945249cb5e040f87159c8 on 2026-10-27
  - commit 05125f70e9297ad8d2b9fadddfb5cd3e1fb0d4ab
  - agent ph71mj3hyjmygq66wy30ncnj158h3gq0 I9-RECOVERY-FD-2
  - commit 56ad8146f3decdca1d3ff427eda9327cac4f52c0
  - agent ph74rex3pescaywbxyjn3njr158h3pp9 I17-CANARY-FD-1
repro: agents/benchmarks/cloudbench_dependency_sync_test.py test_detach_reexec_closes_inherited_launcher_pipe
status: fixed
---

## Problem

After the exact capability proof printed
`CAPABILITY STABILITY PROOF FAILED at slice 0`, its Fleet process was gone but
the top controller remained blocked waiting for `tee` for more than one minute.
Exact-PID inspection found slice tee 2670738 reading pipe inode 12360745 while
detached `agent_link_server` 2670877 still held FD 63 as a writer to that same
pipe. The Hub's standard input was `/dev/null` and stdout/stderr were its own
log, so FD 63 was the only edge retaining the failed slice pipeline.

The permanent pre-fix command was:

`agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_detach_reexec_closes_inherited_launcher_pipe`.

It passed an inheritable pipe writer above FD 2 through the production detach
helper and failed after one second with
`detached child retained the launcher's pipe writer`.

## Diagnosis

Critical path: proof stdout enters slice tee → Fleet launches a persistent Hub
inside that pipeline → `cloudbench_detach_reexec` forks and creates a new
session → it redirects FDs 0, 1, and 2 → it execs the Hub while preserving every
other inheritable descriptor → Fleet exits → the Hub's hidden writer prevents
tee EOF → both slice and outer pipelines wait forever.

What: a detached service retained a controller-owned pipe writer. Where:
`cloudbench_detach_reexec` and its tracked sibling in
`scripts/lib/cloudbench-env.sh`. Why: session detachment changed process-group
ownership but did not close inherited descriptors above stderr. Proof: `lsof`
mapped Hub FD 63 and tee FD 0 to the same inode; the deterministic regression
reproduced the missing EOF while the detached command remained alive.

The deepest owned cause is an incomplete detach contract: durable helpers owned
their session and standard streams but still inherited arbitrary launcher I/O
capabilities. Any inherited lock, socket, or pipe descriptor was a sibling
lifecycle leak.

## Solution

Both tracked and untracked detach paths now redirect standard streams, enumerate
`/proc/self/fd` or `/dev/fd`, close every descriptor above 2, and use
`closerange` only when neither descriptor directory exists. They then exec the
requested helper with no launcher I/O edge. Exact tracked PID/group ownership
and signal handling remain unchanged.

The unchanged regression reaches immediate EOF while the detached command stays
alive, and the complete dependency-sync and multi-workstream lifecycle suites
pass. At 10,000 agents, work is bounded by one process's descriptor table at
detach time; there is no agent-wide scan, channel, lock, shared row, or fan-in.

## Human feedback

The user required exact process and descriptor evidence, no broad process kill,
preservation of unrelated workstreams, a local failing regression, full
lifecycle verification, and exact owned-resource cleanup reporting.

## Reusable lesson

Close every inherited descriptor above stderr before execing a detached helper; a new session alone does not detach launcher I/O ownership.


## Recurrence: isolated fleet runner retained the controller lock

During PR #1299 completion on September 10, the unchanged Linux multi-workstream
scenario 2-cancel failed with `FATAL controller lock failed without a live owner`.
The earlier fix covered detached Hub helpers but missed
`run_fleet_child_supervised`: its Python launcher called setsid/exec while
retaining the inherited flock descriptor. Killing the controller group left
that separately supervised runner holding the dead controller's lock.

Close descriptors above stderr before setsid/exec in this third launcher.
The existing real-source ordered-recovery scenario failed before and passed
after; the complete `scripts/tests/cloudbench-multi-workstream.test.sh` then
passed through scenario 16. Evidence: `.context/acceptance/linux-exact-recovery-repro.log`,
`linux-exact-recovery-fixed.log`, and `linux-multi-workstream-final-tests.log`.
The general class and descriptor-ownership lesson above are unchanged.

## Recurrence: 2026-10-27 exact recovery donated its guard to Fly

Polar k2 I9 reproduced the same descriptor-custody class at another foreign
exec boundary. The September fixes closed descriptors in Rose's detached Hub
and supervised runner launchers, but did not constrain native `flyctl` launched
while a fleet recovery guard was held. Fly may detach its own agent, outside
Rose's detach helper; setting up a new session does not remove inherited files.

Original launch-owner receipts record owner
`49927b5b138945249cb5e040f87159c8`, recovery started at 19:34Z from reported
source `34ff3f23e`, and HTTP409 `runtime evidence is incomplete or changed`
followed by `guest shutdown without sealed runtime evidence` and recovery
exit 1. At 19:51:27Z orphan PID3270232 (PPID1, start ticks7311715, born
19:34:20Z) had fd10 on persistent recovery guard inode2160241. `/proc/locks`
attributed its flock to dead PID3269332. It also retained fd18 on deleted
`cloudbench-guest-recovery-ports.30437W`, matching the recovery proxy loop.
The 19:50:07Z capture refused `exact-owner recovery guard is held; retry after
it exits` after preflight passed.

The owned path is `recover_exact_stale_fleet_owner` →
`acquire_registry_recovery_lock` (Bash opens an inheritable descriptor; Python
locks that same open file description) →
`fleet_recovery_reconnect_guest_shutdowns` (opens fd18, reconnects guests) →
`start_data_plane_proxy` → `cloudbench_start_data_plane_proxy` → native
`flyctl proxy ... &` → detached Fly agent. The first bad owned boundary is the
native Fly exec carrying the unrelated recovery capability. The guard must
remain available to explicit Python ownership-proof helpers, so globally
closing it early or setting descriptor flags in a Python child would either
weaken custody or fail to change the Bash parent's flags.

The offline permanent regression is
`python3 scripts/tests/cloudbench-recovery-fd.test.py`. On parent
`05125f70e9297ad8d2b9fadddfb5cd3e1fb0d4ab`, it failed the three foreground subcases
(direct `flyctl`, `FLY`, `fly_with_timeout`) with native fd10 pointing
at the guard. It invokes real production acquire/release, real flock,
native executable lookup and exec, and `os.fork` into a daemon. It checks
controller exclusivity after native exit17, absence of the guard at native
exec, and reacquisition after controller release while the daemon remains
alive. The fixture closes the timeout FIFO in the daemon to isolate the guard
from the separate completion-FIFO contract; native receipt is captured before
that fixture cleanup. Linux procfs is explicit; other hosts skip this receipt
fixture. The fake Fly never calls a provider and does not replay HTTP409.

Fix: a fleet-local native `flyctl` wrapper uses a temporary command redirection
to exclude the recovery guard from foreground native exec, restoring the
controller's descriptor after return. Both background native proxy launches
(status and autoscaler metrics) close the guard and exec Fly inside their
existing asynchronous child. This preserves `$!` as the native process PID,
parent flock lifetime, args, streams and exit status. A wrapper with a nested
subshell was rejected by independent review before application because it
would have published Bash's PID instead. Two permanent subcases now extract
the real background launch blocks and assert native PID ownership as well as
descriptor exclusion. The final unchanged test failed five subcases in 0.575s
before runtime application and passed all five in 0.587s after it. Explicit ownership
proof helper handoffs retain their existing descriptors. The regression is
registered in normal offline and deploy structural suites.

Golden references opened: Codex `codex-rs/utils/pty/src/pty.rs:541-567` and
`codex-rs/utils/pty/src/spawn_helper_main.rs:77` exclude unrelated descriptors
at the child exec boundary; its
`codex-rs/rmcp-client/tests/stdio_descriptor_boundary.rs:32-66` tests both native
and descendant exclusion without Python's default fd cleanup. Hermes
`hermes_cli/update_cmd_posix_pause.py:531-532` uses `close_fds=True` for a
detached restart. OpenClaw `scripts/run-openclaw-podman.sh:86` closes a Bash
file descriptor explicitly. These converge on child-only noninheritance;
intentional helper descriptor custody is a distinct contract.

Archive searches: `exact-owner recovery guard is held` and
`inherited descriptor flock daemon`. This is a recurrence of this case's
incomplete foreign-exec descriptor contract, rather than a new HTTP409 cause.
The unrelated WireGuard-peer case dated 2026-10-18 was also read; it does not
explain custody of this persistent inode.

Limits: no paid benchmark, deploy, provider mutation or task-definition edit
was performed by I9. The launch owner independently stopped the exact historical
agent under coordinator authorization and reported lock release and successful
capture; a later archive-builder mismatch is separate. Neither historical
resource release nor successful original task outcome follows from this source
fix. No native Fly daemon was started by the offline fixture. The original
HTTP409/evidence incompleteness is not fixed by descriptor exclusion.

Human direction for I9: use a separate devbox, preserve Freedom and lock lifetime,
leave original resources to their owner, obtain independent opened-reference
GROUNDED review before runtime application, register the regression, push a
row-tagged commit and report exact proof and limits.

### Review and source binding

Independent opened-reference review `ph71mj3hyjmygq66wy30ncnj158h3gq0` returned
`GROUNDED` for `I9-RECOVERY-FD-2`, exact patch SHA256
`325d56c2230992d74bac708a726b3ccdf6192a4cdac4443818cd27eccecd65b0`,
before any runtime/registration patch was applied. It opened the cited Codex,
Hermes and OpenClaw references, searched Claude, Prime and Kimi for contrary
practice, and independently probed argument/stream/status and native PID
preservation. Original rejected snapshots were never applied. The runtime
patch contains no prompt, task, evaluator, timeout or provider-policy changes.

The launch owner's original fleet execution provenance records clean base
`34ff3f23e6efa9ced9ff75732357df973db14e86`, no workspace patch, and snapshot
aggregate `74d819a83e751a4a0807b381d5a4a54100807fd5053e691766f7418f7951adf6`.
Reconstructing its 80 files from the committed copy list reproduces that exact
aggregate with inherited cp umask 077 (the seeded copy2 helper preserves its
mode). The five owning recovery/proxy functions are byte-identical to parent
`05125f70e`. The recovery invocation's removed temporary snapshot has no
surviving per-file manifest; its exact historical execution binding remains
unverified. Review explicitly accepted the mechanism grounding independently
of that gap. This is a source-level repair, not original historical outcome
proof or a claim that source changes released any resource.

### I9 verification

- Frozen descriptor regression: 2 tests / 5 cases pass (0.587s), unchanged
  from the 5-failure pre-fix artifact (0.575s).
- Bootstrap recovery: 233 tests in 389.176s, OK with 7 existing skips.
- Environment shell suite and its embedded Python/kernel-lock checks pass.
- Archived transport 8, archived reuse transport 4, and native startup 4 pass.
- Shared transport: 13/14 passed initially; its legacy native-exec fixture was
  corrected without assertion changes and the remaining test passed (1.523s).
- Deploy structural runner: 48/50 passed initially; missing command listings
  and host `lsof` were corrected, then both failed tests passed (0.149s).
- Proxy reaper passes after accepting indentation in its exact startup-call
  matcher. Archive validation, Bash/Python syntax and diff whitespace pass.

Supplemental fixture/registration-documentation changes were independently
reviewed `GROUNDED` at SHA256
`b61cb9385ebaa9b3f7104428fb881802493758a7ec5488ac275eb249a525df44` by the
same non-author reviewer. No production runtime bytes changed after the
pre-application runtime verdict. Local proof artifacts are retained under
`.context/polar-k2-i9/`; the permanent regression and this case are committed.

## Recurrence: 2026-10-27 canary preflight donated its transaction to native Fly

Polar It4 I17 is the same custody class at a distinct source-owned boundary.
I9 excluded the Bash recovery guard at native Fly execution; that does not
constrain the preflight helper's explicit `pass_fds` of a different transaction
FD into the entire canary tree. Parent-reported original source is
`56ad8146f3decdca1d3ff427eda9327cac4f52c0`: campaign742460 (birth7923571)
had 30 jobs awaiting preflight before allocation. Canary fleet1448491 launched
`run-bench-cloud --verify-secrets`1456644, whose native `flyctl secrets list`
1456787 remained hung for over13 minutes with the preflight transaction lock
inherited. Original process receipts belong to launchowner
`ph7bpz2f14pct3j92t0e6nrvmx8h3nep`; original cleanup is exclusively that
owner/coordinator's operation, not an effect inferred from a source patch.

First bad owned boundary: `_run_owned_canary` in
`scripts/cloudbench-infra-canary-preflight.py` explicitly passed the lock
handle via `Popen(pass_fds=...)` to Bash. Bash's later native execs inherited
that inheritable descriptor, so foreign blocking calls and detached daemons
could keep a transaction they do not own. `run-bench-cloud` verification's
missing timeout is separately owned by I16; timeout repair does not exclude
this descriptor from later foreign processes.

Simply removing `pass_fds` is wrong: the existing canary suite requires a
canary to retain transaction custody if the outer preflight helper is killed.
The repair confines deliberate inheritance to a small source-owned Python
supervisor. That supervisor marks its handle noninheritable, launches the
original canary with `close_fds=True`, forwards TERM through the same monitor
and waits for its actual child before closing custody. The outer helper uses
the same original monitor for that supervisor. Parent stamp/failure publication
still happens while the original parent holds its descriptor. There is no
explicit unlock, lock unlink, replacement inode, process-group kill or timeout
change. One additional Python process exists per active canary, not per job.

Permanent causal repro:
`python3 scripts/tests/canary-preflight-fd.test.py`. It runs the real helper,
real flock, Bash native exec and a fixture process that forks a detached daemon.
On the exact buggy source, four outcomes (success, exit17, outer helper SIGKILL,
cancellation) fail native descriptor exclusion in0.651s. It separately requires
lock exclusivity throughout live native execution even after outer helper
death, delayed native cancellation cleanup and join, correct exit/stamp behavior,
and reacquisition after native exit while the unrelated daemon remains alive.
The fixture only releases or signals exact processes it created. It uses Linux
procfs for FD receipts with an explicit platform guard; the existing portable
shell canary crash/follower test remains unchanged. The regression is invoked
by the already registered `scripts/tests/fleet-infra-canary.test.sh` suite.

Opened references: OpenClaw `scripts/pr-lib/process-group-runner.mjs:36-48`
retains creator custody in a supervisor; lines333-345 explicitly specify
child stdio and lines530-565 wait for drain before retiring custody. Codex
`codex-rs/utils/pty/src/pty.rs:541-567` and
`codex-rs/utils/pty/src/spawn_helper_main.rs:77` exclude unrelated child
FDs; `codex-rs/rmcp-client/tests/stdio_descriptor_boundary.rs:29-66` tests both
native child and descendant exclusion. Hermes
`hermes_cli/update_cmd_posix_pause.py:531-532` uses `close_fds=True` for detached
restart. Contrary intentional custody in `hermes_cli/update_lock.py:1194-1219`
passes locks to mutator children to survive parent death; our source-owned
supervisor retains that duty while foreign Fly does not receive it.

Archive searches: `transaction lock inherited` and
`detached helper inherited descriptor`. This is a recurrence of this case's
foreign-exec capability leak, not a recurrence of the historical recoveryguard
path itself. Preserve both proofs and scopes.

Limits: the offline proof establishes descriptor ownership and supervision,
not successful original campaign outcome or live provider behavior. A native
canary that ignores TERM still retains custody until it exits, as before; I16
owns its bounded provider-call cancellation. Killing the custody supervisor
itself is not the same as killing its outer parent and no blanket crash
immunity is claimed. Source-owned canary cleanup still owns its resources.
No paid run, provider mutation, deploy, task edit, original PID signal or
Freedom change was performed by this owner.

Human direction: preserve parent lifetime and child PID supervision, obtain
independent opened-reference exact-snapshot GROUNDED review before runtime
application, coordinate without overlap with I16, push a small row-tagged fix.

Independent opened-reference review by
`ph74rex3pescaywbxyjn3njr158h3pp9` returned `GROUNDED` for
`I17-CANARY-FD-1`, exact runtime/test patch SHA256
`9bc0b8229a6376e98951bf86adc5bfc98377e5fa628a089548ce0825604acfe9`,
before application. The reviewer independently ran the exact new regression
in an automatically cleaned temporary fixture (four outcomes green, ~1.027s).
The unchanged post-application command then passed all four outcomes in0.948s
on this owner's checkout. No runtime bytes changed after that review.

Original I17 receipts subsequently arrived and were opened: at22:46:58Z
native Fly1456787 had elapsed13:41 and its FD table included the exact
transaction path. At22:48:23Z preflight1448488 (birth8035758) held FLOCK WRITE
on inode2157345 with29 waiters; canary1448491 (8035761), verify1456644
(8036734) and nativeFly1456787 (8036755) all held that path. Launchowner's
terminal receipt records the independent authorized campaignTERM at22:48:31.701Z
and final cancellation22:52:05.629925Z, zero remaining transaction flocks,
30 failed-epoch own-removed seals and no Machine created since22:14Z. Those
are original owner cleanup receipts, not effects credited to this source fix.
The canary shell suite passed after application, including its unchanged
helper-crash/follower control and new FD regression (1.000s in-suite).
The owning cleanup-ticket campaign suite also passed20 tests in46.010s,
including cancelled parent canary join and failure-before-worker-fork controls.
Archive validation, Python/Bash syntax and whitespace checks passed.
