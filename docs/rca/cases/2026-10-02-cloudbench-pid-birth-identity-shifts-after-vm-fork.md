---
id: 2026-10-02-cloudbench-pid-birth-identity-shifts-after-vm-fork
date: 2026-10-02
title: Cloudbench PID birth identities came from Linux ps lstart, which every live process changes after a VM snapshot fork steps the wall clock
surface: infra
component: cloudbench-fleet-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench_pid_start_time / script_snapshot_current_pid_start / agent_link_server._pid_start_time / cloudbench-port-lease.py / cloudbench-script-snapshot.py mint and verify process birth identities with `ps -o lstart=`, which Linux procps renders from the kernel's current boot-time estimate rather than a value fixed at fork
symptoms:
  - "❌ script snapshot owner birth drifted from sealed identity"
  - "stack cleanup receipt does not match its original process"
  - "FAIL: mandatory autoscaler attach budget must not run while its primary is intentionally stopped behind the boot-config barrier"
  - "cloudbench-multi-workstream.test.sh blocked in wait(1) on a live test Hub after the failure"
  - "Could not capture the process table for owned tree teardown (first fix, failed controllers only)"
tags:
  - cloudbench
  - process-identity
  - vm-fork
  - deploy-gate
sources:
  - PR #1341
  - PR #1503
repro: scripts/tests/cloudbench-pid-identity.test.sh replays a +143s wall-clock step with a ps shim; the pre-fix tree fails 4 checks (live owner, Hub owner record, script-snapshot owner, and a live port lease reaped as stale) and the fixed tree passes all
status: fixed
---

## Problem

During `/deploy` run `20261002-213707-2123940`, the 4cb lane's
`cloudbench-multi-workstream` scenario 2b2 printed `1/1 passed`, but the
controller then exited nonzero with `script snapshot owner birth drifted from
sealed identity`. The test's EXIT cleanup then blocked in `wait` for more than
10 minutes on a live test Hub, and the lane had to be terminated by PID.

## Diagnosis

### Evidence

- `dmesg` shows `random: crng reseeded due to virtual machine fork` at 22:10
  (the Cloud Agent VM was snapshotted mid-run).
- The live test Hub 2235458 had `pid_start=Fri Oct 2 22:03:07 2026` in its
  owner file. After the fork, `ps -p 2235458 -o lstart=` reported
  `Fri Oct  2 22:05:30 2026` for the same live PID, a shift of +143s.
  `/proc/2235458/stat` start tick 8938378 is unchanged and gives
  `btime + 89383s`, which is the new value.
- procps renders lstart as the current boot-time estimate plus the start tick.
  A wall-clock step after a pause moves that estimate, so every live process's
  lstart moves with it.
- The test hub teardown checks `cloudbench_pid_matches_start` before sending
  TERM. The check failed, so TERM was skipped, and the following `wait` on
  the still-running child never returned.
- The same mismatch makes `registry_owner_alive` report a live fleet as dead,
  `cloudbench-port-lease.py` reap a live lease, and the capacity-reservation
  sweep delete a live reservation.

### Root cause

PID birth identity is meant to be fixed for one process incarnation. Linux
`ps -o lstart` is derived from the wall clock, so it is not stable. On macOS
lstart is recorded once at fork and is stable, which is why the scheme worked
on developer Macs.

## Solution

On Linux, every cloudbench producer now mints
`proc-start:<boot_id>:<start tick>` from `/proc/<pid>/stat`. The producers are
`cloudbench_pid_start_time`, the detached session leader, run-bench-fleet's
pre-library script-snapshot identity and `fleet_pid_start_time`, the Hub owner
record, and the port lease. The teardown process table and observations read
the same `/proc` record. Verifiers dispatch on the recorded format, so `lstart`
records written by an older controller keep their original meaning. Fleet
registry records keep the edge-trimmed `lstart` spelling on macOS so that
live owners from older controllers stay alive in the shared registry.

`scripts/tests/cloudbench-pid-identity.test.sh`, called from
`cloudbench-env.test.sh` (deploy lane 4cb), replays a +143s step with a ps
shim. It requires every producer to emit the same identity, every verifier to
keep matching live owners across the step, a live port lease to survive a
neighbor's reap, and exited owners to stop matching.

### Follow-up: identity helpers inside EXIT traps

The first version of the fix ended `cloudbench_process_birth_table`,
`fleet_pid_start_time`, and `fleet_pid_matches_start` with a bare `return`.
Fleet teardown calls them from the controller's EXIT trap, and there a bare
`return` reports the status from before the trap, which is the controller's own
exit code. Every fail-closed autoscaler controller in the multi-workstream
test, plus scenario 16's provisioning runs, logged
`Could not capture the process table for owned tree teardown`
and orphaned its snapshot and aggregator loops to init: 11 leaked loops in one
run. After a successful run (pending status 0), a dead `proc-start` owner would
read as alive. Those tests only asserted the nonzero exit, so they passed.

Each helper now ends with the scanner or matcher as its last command. The
identity test runs teardown and matching from an EXIT trap with pending status
0 and 3. On the first fix it reports `fleet-dead=match` at status 0 and
`table=failed teardown=failed loop=alive` at status 3. With the fix every
check passes. `cloudbench-multi-workstream.test.sh` now fails if any controller
log reports a teardown survivor, or if any controller process outlives its run.

### Follow-up: fixtures that faulted or omitted the old source

After the October 6 merge of `main`, deploy lane 4cb failed in two places.
Both were fixtures that still reached identity only through `ps`.

- `cloudbench-hub-reaping.test.py` (added on `main`) faked a drifted or
  unknown Hub birth by stubbing `ps -p <pid> -o lstart=`. Linux Hub records
  are `proc-start:` identities, so the stub never reached the read. The
  drift and unknown cases reaped the live Hub and failed with exit 14 and 15.
  The fixture now also faults `cloudbench_proc_pid_observation` for the
  target PID. Its fault variable is renamed because `cloudbench_pid_start_time`
  declares `local observation`: dynamic scoping shadowed the fixture's value,
  and under `set -u` the drift case passed only as an unknown. A probe of
  `cloudbench_pid_birth_state` now shows `live`, `absent`, and `unknown` for
  the normal, drift, and unknown cases.
- Five `cloudbench_dependency_sync_test.py` fixtures extracted
  `registry_owner_alive` or `inventory_refresh_lock_acquire` without the
  `fleet_pid_*` helpers they call. The resulting `command not found` read
  every owner as dead. One recovery fixture failed closed on it. The others
  passed vacuously, including the sealed-lock fixture, which never acquired
  its lock. They now load the helpers ahead of any fixture stubs. The
  sealed-lock fixture now injects its drifting source at `fleet_pid_start_time`
  and must acquire and release, so it fails when release re-reads identity.
  `test_extracted_fleet_pid_identity_callers_include_birth_helpers` fails
  whenever a fixture extracts an identity-reading fleet function without
  the helpers.

`scripts/setup-db.sh` still uses lstart. There, descendant identities are
captured and re-verified within one bounded teardown, so the exposure is a
fork inside that teardown window rather than across a run.

### Follow-up: the service stack's worker supervisor was still a sibling

The October 7 original 50-task control left two service stacks in `failed`
without a worker-drained acknowledgement. Their original driver logs refused
to acknowledge release. The first effective worker shutdown signals appeared
only during recovery, and the workers then finished promptly. Original service
records retained worker PIDs, but did not retain the supervisor's captured birth
or an observation of the failed pre-signal comparison. That is an attribution
gap: the original control does not establish that a clock step caused these
two failures. It exceeded its original one-hour E2E limit and earns no credit,
regardless of subsequent recovery.

The runtime evidence did lead to an unconverted producer/verifier pair:
`run.sh` captured `AGENTS_BIRTH` with human `ps lstart`, and
`run_wait_owned_agent_shutdown` compared that rendering before signalling the
supervisor. The existing Linux clock-step blackbox now launches a real owned
child, evaluates the shipped capture assignment, steps the existing `ps` shim,
and calls the shipped drain helper. The original source fails with
`the owned stack worker must drain across a wall-clock step`; the unchanged
test passes after both boundaries use the existing shared process identity.
It also verifies graceful TERM completion and an untouched sibling. This proves
the known clock-step mechanism, not the missing original control attribution.

The helper reads according to the recorded format, preserves legacy macOS
identities, and sends one TERM to the supervisor rather than its worker tree.
After signalling, an empty identity observation with a still-live PID must
continue joining within the existing shutdown budget. It cannot certify exit.
The existing process-cleanup blackbox faults that one read against a native
child which exits only after the next observation. Restoring the premature
empty-read return fails; the unchanged test passes with the join. It also
preserves the unknown-birth, foreign-birth, already-reaped child, unrelated
workspace, exact DB instance, and service/test-process controls.

The shared identity library is loaded only by the drain helper when absent;
unrelated consumers of the cleanup library do not acquire a new import-time
dependency. Both owning tests remain in their existing normal deploy lanes.
No stage budget, execution timeout, task, prompt, model, or evaluator changes.
Complete original fleet release still requires the canonical recovery path;
these local regressions do not substitute for a qualifying live 50-task run.

Independent review also caught a fixture mask: the clock-step test loaded the
shared identity library before evaluating the stack capture assignment, while
the actual `run.sh` import list did not provide that function. A fresh-shell
control now evaluates the shipped library import lines and exact capture and
drain against its own native child. It fails with `cloudbench_pid_start_time:
command not found` before the actual entrypoint imports the shared library, and
passes unchanged after that import is added. This control runs before the Linux
clock-step section, so macOS also checks the real dependency boundary.

At 10,000 agents this change still reads only the local supervisor's fixed
process record and joins that exact owner within the existing budget. It adds
no fleet-wide scan, shared row, broadcast channel, or cross-agent lock.

### Recurrence: local stack receipt re-rendered wall-clock birth

On October 13, retiring isolated stack `1791894395-3418352-47084` verified
its original owner with the stable native process identity before TERM and
joined its exit. All five original service processes were absent and the
three owned listeners were closed. However, `stop_services` rejected the
native cleanup receipt: the recorded startup birth was 12:26:35 UTC, while
`run_publish_stack_cleanup_status` rendered 15:34:46 UTC at shutdown. The
original receipt remained `state=clean`; its PID and ownership token matched.
The observed shift is established, but its specific VM/NTP trigger was not
captured. The original failed benchmark result remains failed.

The first bad boundary is `scripts/lib/run-process-cleanup.sh` publishing a
fresh `ps lstart` value as identity, followed by `agents/benchmarks/local.py`
requiring equality with the startup rendering. The signal guard already uses
stable native identity, so the receipt producer and verifier disagreed about
the same owner. PR #1503 records native identity in new receipts and verifies
that exact value, PID, unique token, and clean state. Existing receipts keep
their original birth check. A shifted legacy receipt is accepted only by the
same invocation that verified, signalled, and joined its exact native owner;
an already-stopped mismatched legacy receipt remains rejected without that
proof. The original October 13 receipt was not rewritten or upgraded.

The two permanent controls in `agents/benchmarks/local_lifecycle_test.py`
failed unchanged on the previous source and both pass after this fix. They
exercise the public cleanup boundary with ten ownership/state cases and the
actual shell publisher with shifted wall birth. Foreign native identity,
recycled PID, wrong PID/token, failed state, unproved legacy drift, and failed
signal proof remain strict; inability to read native identity preserves the
previous receipt. The existing process-cleanup shell suite also passes.
These controls are discovered by the normal benchmark blackbox domain under
`/deploy` agents coverage. Private source-bound red/green and retirement
receipts are retained under the Google RCA sandbox-policy-check directory.

At 10,000 agents, this remains one local process-identity read per isolated
stack receipt with no shared database, fleet scan, or additional provider call.
It does not change payment verdicts, budgets, prompts, models, or tools.

The first aggregate qualification also caught a fixture composition gap:
the actual boot/driver interrupt control sourced the real cleanup library
without defining the `SCRIPT_DIR` binding provided by production `run.sh`.
The new writer correctly failed on that missing dependency and withheld the
guest cleanup acknowledgement. Supplying the fixture's real script directory
makes the unchanged owning control pass instead of HTTP 500; all 13 assertion
ASTs are identical, including exact root deletion, clean matching token,
HTTP 204, terminal acknowledgement, and cleanup ordering. Ten existing negative
cleanup controls also pass. No production fallback or dependency predicate was
weakened to accommodate the fixture.

## Human feedback

Keep broad stage completion and whole-run timing as the operational gates;
avoid narrow internal timing assertions. A failed observation is a warning to
continue monitoring, and cannot serve as proof that an owned resource is gone.

## Reusable lesson

A process birth identity must come from a value the kernel fixes at fork. On
Linux that is the `/proc/<pid>/stat` start tick. `ps -o lstart` is a rendering
of the wall clock, and it changes for every live process whenever a VM pause
or NTP step moves that clock.

A shell helper that teardown can reach from a trap must not end in a bare
`return`. Make the command whose status matters the last command.

### Recurrence: cloud driver ignored the native stack receipt

The next review of source `4f332c0c8b` found the same producer/consumer
boundary in `cloudbench-run.sh`. Its `publish_cleanup_ack` still compared
`stack_birth` and ignored `stack_native_identity`. The actual acknowledgement
function rejected a matching native owner when the wall-birth rendering
shifted, and accepted a foreign or empty native field when the old birth
matched. This is a local source reproduction, not evidence that this defect
caused another production retirement failure.

The stack publisher now writes schema version 2 with mandatory native identity.
The trusted guest driver captures the original identity immediately after
launch and requires exactly one version field and one nonempty matching native
field for v2, plus the existing PID, unique token and clean-state guards.
Version 1 without native identity retains its exact original birth check; v1
with native identity requires an exact match and treats wall birth as cosmetic.
Receipt lines must be key=value with unique keys and complete values.
Unknown or duplicate versions and missing, empty, duplicate or foreign v2
native fields fail closed. Stack version/state/token/PID are required; native
wall birth remains optional. Root interrupt state/token are required, with
declared version1 only and absent-version legacy compatibility. Unknown unique
optional fields remain supported. Valid pending/failed diagnostic copies and
original invalid source files remain retained. The local stack reader accepts v1/v2 explicitly;
benchmark interrupt receipts retain their v1-only default. A verified owner
signal cannot forgive a missing v2 native field. Termination signaling is
unchanged because no separate local signaling defect was demonstrated.

The identity helper travels in both existing boot and legacy control bundles
and is resolved beside the immutable driver, never from the target checkout.
Only the exact filename `process-identity.py` is added to payload admission;
its bytes still must match the immutable bound source. No arbitrary filename,
source or phase exception is introduced.

Initial schema/staging proof failed10 of38 checks on the previous source,
then all38 passed. Two controls then caught truncated native/version values
in that candidate: the same40 suite failed2 before and all40 passed afterward.
Whole-stack-field controls failed9 of56 before structural key checks and
complete values, then all56 passed. Finally, root evidence controls caught
that same false acknowledgement in root state/token and schema parsing:
the unchanged70 suite failed9 before and all70 passed after the final repair. They include the unchanged seven legacy receipt and three
root evidence checks, native schema/capture controls, payload transport and
corruption checks, and the real boot-to-driver-to-runner interruption flow.
All 13 assertions in that existing boot flow remain unchanged and it needs no
fixture copy with the staged helper path. The same 12 local lifecycle controls
fail three new-protocol checks before the fix and all pass afterward; the
writer's version assertion follows the explicit v2 contract, while all old
v1 behavior controls remain intact. Private Git/source-bound logs retain the
original failures and corrected outcomes. New full qualification and rollout
remain pending; the original failed benchmark and native receipt are unchanged.

At 10,000 agents this adds one process-identity read per isolated stack launch
and constant-size receipt checks, with no global scan, new provider request or
financial allocation. Models, prompts, task criteria and deadlines are unchanged.

### Recurrence: sealed controller snapshot omitted the native identity helper

Fresh canonical Group 3 on frozen `71b5adb6d267a0fdfeb489eafdea6f042de3a5c0`
failed its controller lane at 20:27:20 UTC after 117.6 seconds. The first failed
assertion was `workstream A's benchmark run must FINISH WITH SUCCESS alongside
a concurrent run (exit=1)`. Both exact child logs rejected the packed boot
payload before boot-ready. The earlier `missing_startup_visibility_dependency`
traceback belongs to an intentional negative control that passed; it did not
cause the concurrent-run failure. The failed native stage and all preceding
negative-control results remain preserved.

The guest consumer now stages `process-identity.py` from the immutable controller
bundle, but `run-bench-fleet` omitted that required file from its explicit
snapshot copy list. Direct guest/boot controls had the helper available and
passed, while the normal public fleet producer did not supply it. The first
bad boundary is that producer-to-consumer dependency closure, not receipt
parsing or native process identity. Adding the existing helper to that sealed
copy list is the only runtime correction.

The unchanged `CLOUDBENCH_TEST_CONCURRENT_RUN_SELF_TEST=1` public fixture fails
with exit 1 before the addition and passes with exit 0 afterward, including
both successful distinct-code workstreams, exact resource teardown and
read-only shared-app assertions. The new permanent
`test_boot_payload_fleet_snapshot_stages_native_identity_helper` also fails
before and passes after: it invokes the actual public launcher, checks frozen
helper bytes and the manifest digest, packs and unpacks the helper through the
real checksum-bound transport, executes it to capture a native identity, and
verifies exact snapshot cleanup. Its assertions are identical in both runs.
The private full-tree candidate is
`c5705b1e02cdc84115b50ed52460dc97e9a67dbc`; source-bound logs and
`phase2-snapshot-proof.json` remain under the Google RCA sandbox-policy-check
directory. No existing test body or task criterion was relaxed.

The failed 71b Group 3 lifecycle was closed and launched no new Group 4. Earlier
4f benchmark and latency receipts remain historical. Private red/green proof
does not convert that failed canonical stage to PASS; final complete-source
qualification and rollout remain pending. At 10,000 agents, this copies one
existing small helper per isolated controller snapshot, with no added provider
request, allocation, global coordination or timing allowance.

The subsequent complete-source coverage run on
`de189146623c5955251259e609386b111b73513a` failed one of 110 domains because
the permanent boot-payload wrapper still asserted `26 passed`. Its unchanged
pytest selection successfully ran all 27 tests, including the new sealed
snapshot control. Replaying the exact public wrapper preserves that original
FAIL; updating only its expected registered count to 27 makes the wrapper PASS.
Both underlying native selections return exit 0 with 27 passed; their test
bytes and assertions are unchanged. This is test registration maintenance,
not a runtime, provider or task acceptance failure. The source recipe remains
`c1606f37698d1cfe48f7beaa6c02fa78e65aaaaf8c1f0fd5c9a439c33b6cebef`.
The failed coverage receipt remains FAILED, its controller successor was never
launched, and fresh canonical qualification remains pending. Source-bound
private receipts are retained in `phase3-count-proof.json`.
