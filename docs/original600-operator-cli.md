# Versioned original600 operator

Use this harness lineage, whose immutable parent is
`b0fbd7742dde51446288c22601825a85981c1d0b`. Do not substitute an older main
`run-bench` implementation or cherry-pick this lineage's unrelated backend over
current production. Checkout the published **operator commit**, not a floating
branch tip; that exact commit is also the controller's fetched source reference.

This public CLI replaces the historical private capacity reader, config binder
and external-owner script. All host inputs and output locations are explicit.
Guest `/tmp/gate/repo` paths are the existing controller mount contract, not a
dependency on a previous operator's host `/tmp` files. No original attempt or
receipt is copied forward as a new result.

## Inputs and ownership

Run as the selected ordinary operator UID, with that user's authenticated,
installed Fly CLI v0.4.115 on PATH. Other versions refuse before provider reads;
the observed JSON organization alias contract is pinned to this operator version.
Keep HOME unchanged. The state directory must be
physical, owned by that UID, mode0700. All input files must be physical,
single-link, same-UID, mode0600. A wrong-UID root/private file must not be made
world-readable; provision complete inputs for the intended operator instead.

Supply the complete authoritative agents and backend env files, the authentic
selected warm snapshot inventory and dependency fingerprint, and a private facts
JSON containing `app`, digest-pinned `image_ref`, `protected_machines` and
`protected_volumes`. The app is fixed to `navi-whisper-lux-bench`. Preserve the
existing protected resource cohort; never invent IDs to satisfy admission.

The exact original ordered200 task manifest is committed at
`scripts/tests/fixtures/original600-tasks.json`. Copy its exact bytes to a private
input file, e.g. `install -m600 scripts/tests/fixtures/original600-tasks.json "$TASKS"`.
The runner verifies the original ordered names hash and pins task source
`1387ae608e7cfb8e3f0a876daae92093f503b465` (earlier runs used `c9875959893737ed352b6ccd08372faa94a4745d` and
`570830dbf17635e13d16a6f03b4d705f6b6443b1`; observe and recover a run with its
own source checkout, whose validators carry its pin). No task selection, prompt, evaluator,
concurrency, retry or timeout override exists in this wrapper.

## One command

First omit `--run` for local source, UID, credential-input and CLI checks with
zero provider calls. Then use the identical command with `--run` to read fresh
organization capacity, bind a new operation and own its controller to closure:

```bash
python3 scripts/run-original600-controller.py \
  --source-ref "$EXACT_OPERATOR_COMMIT" \
  --state-dir "$PRIVATE_STATE_DIRECTORY" \
  --facts "$PRIVATE_FACTS_JSON" \
  --agents-env "$COMPLETE_AGENTS_ENV" \
  --backend-env "$COMPLETE_BACKEND_ENV" \
  --tasks "$TASKS" \
  --snapshot-inventory "$AUTHENTIC_SNAPSHOT_INVENTORY" \
  --warm-deps "$AUTHENTIC_DEPENDENCY_FINGERPRINT" \
  --run
```

No secret is printed or passed as a command argument. The CLI token comes from
the selected agents file. Capacity reads use the requested organization
(default `personal`), a fresh complete app list and every app's native Machine
inventory. The read phase retains the original110-second bound, without
background worker threads that could outlive a drip-fed response. Capacity is
not atomic; the proof says so. It conservatively subtracts the separately
declared unlisted/destroying allowance (default1), requires at least601 new
slots without archived reuse, and must be younger than270 seconds at binding. A later allocation admission
still rechecks the existing canonical authority. No quota is increased.

The controller remains performance-8x/32768MiB with a256GiB workspace. The actual
benchmark remains200 tasks ×3 repeats,600 concurrency, one infrastructure retry,
1200-second tasks and the original5400-second campaign clock. The7200-second
host watchdog covers bootstrap/export/cleanup and does not extend task clocks.
Complete environment bytes are sent only to this new controller, without
changing app secrets.

The printed new state directory contains the original capacity reads, immutable
config/authority, caller identities, gate log and eventual terminal receipt.
Keep the CLI alive through cancellation and cleanup. Its existing native
supervisor protocol signals only its exact owner and retains ambiguous creation,
writer or export states. A failed create is not proof of no effect; do not
fabricate resource ownership or cleanup receipts. Successful exit alone is not
an original600 success: inspect the canonical600 outcomes and unique-infra count.
Local offline fixture passes do not qualify actual capacity, R2 publication,
provider allocation or the five-consecutive-run goal.


### Expired admission that never launched a controller

An expired admission must never restart its original clock. Preserve its entire
private directory, including the original admission intent, request, closed
reservation plan, failed wire records and the positive tool-join/capacity-refusal
receipt. The versioned expired-admission validator also requires the recorded
expiry/no-launch observation. It verifies the known source protocol, full local
journal membership and fresh stopped native identities.

For a new original600 admission, add the expired directory alongside the complete
original predecessor archives:

```bash
  --archive-run "$ORIGINAL_PREDECESSOR_ARCHIVE" \
  --expired-reservation-run "$EXPIRED_UNLAUNCHED_ADMISSION"
```

Use the normal local `--check`, then `--run` with the same inputs and a new
admission. Do not also pass the same directory through the unused or parked
reservation modes. Confirmed reservations and positively acknowledged held
updates may qualify only when their exact native incarnation and full
configuration still match. Unknown writes stay held even when their current
marker looks plausible. This preparation gives no capacity credit.

Before native reservation, the CLI seals the expired directory to that one new
cohort and request. A second unrelated successor is refused. Every credited
Machine then passes the ordinary new native lease, version-checked reservation
and fresh readback. The old deadline, failed attempts, claims, volumes and
receipts remain unchanged; the new admission gets its own explicit clock.

### Reuse preserved Machines from completed controller archives

To reuse the preserved Machines of prior interrupted runs, add one
`--archive-run` for each original run directory to the same command above:

```bash
  --archive-run "$PREVIOUS_RUN_DIRECTORY_1" \
  --archive-run "$PREVIOUS_RUN_DIRECTORY_2" \
  --reuse-exclude-machine "$OPTIONAL_CHANGED_MACHINE_ID"
```

The exclusion flag is optional and repeatable. For example, exclude a Machine
whose current instance changed during a separately recorded capability probe;
an old inventory must not substitute for its new ownership evidence. Supply the
complete original run directories with their verified controller export,
terminal and cleanup records, not a list of Machine IDs. Keep those directories
and their private original artifacts available. Missing or conflicting evidence
refuses reuse; do not edit old receipts to make them match.

Without `--run`, this is still a local source/input check with no provider
calls. With `--run`, the CLI reads fresh capacity and verifies archived ownership,
protected resources, stopped state, instance, configuration and attached Volume.
An eligible stopped Machine is not free quota. Only an exclusive, durably
recorded native reservation that has been read back can reduce new allocation
demand. With R such reservations, the unchanged600-task campaign needs
`601 - R` new Machine slots, including its controller. Existing objects remain
in the organization's measured total. All qualified candidates are considered
before creating fresh Machines; protected or unproven candidates receive no
credit.

New source snapshots also bind a private byte-offset index to the exact reserved
request. The parent validates every candidate before building it. Both index
and request hashes enter the launch configuration; each worker streams the
whole request hash and decodes only its assigned row. Missing legacy indexes
retain the original validation path. A supplied invalid index refuses work and
cannot fall back to full-request parsing. This reduces worker memory without
changing the 600-job concurrency, task identities, deadlines or native leases.

An individual reservation failure is retained as a held, uncredited candidate;
it does not cancel unrelated reservations. The closed plan contains only
confirmed reservations. After those workers join, the same admission makes one
bounded observation pass over held rows with a verified successful raw update
ACK. It acquires a fresh lease and reads the exact acknowledged incarnation and
configuration; it never sends another configuration update. Only a matching
inactive readback followed by successful lease release adds capacity credit.
Unknown, unsuccessful or missing update ACKs remain held. The original closed
plan and failures stay unchanged; a separate observation journal records the
derived request. An incomplete observation journal cannot be replayed.

The observation pass retains the original admission deadline and propagates
cancellation after releasing its owned lease. The final fresh capacity check
still requires every remaining new Machine slot. Cancellation stops queued work and joins active operations;
a prepared intent can resume only with its exact durable proof that dispatch
did not begin. Unknown dispatched writes remain held.

Before native reservation, the CLI checks available filesystem blocks and
inodes against a conservative estimate of retained native/configuration copies,
wire receipts, possible held-row observations and fresh inventory snapshots.
This is a preflight estimate, not a filesystem reservation; other processes can
still consume space. Preserve the original journals if any write fails.

For a positively observed, joined admission failure before any controller was
created, the explicit continuation accepts the original directory and its
source-bound failure receipt:

```bash
  --resume-incomplete-admission "$ORIGINAL_ADMISSION" \
  --incomplete-admission-failure "$OBSERVED_FAILURE_RECEIPT"
```

Use the identical original inputs and predecessor archives with the new
published host operator. The validator retains the original workload checkout,
cohort and deadline. It seals the incomplete journals, observes positively
acknowledged reservations under new leases, and may reserve an untouched row
only after proving its old configuration update was never dispatched. A single
update with a missing response can qualify through a fresh leased read of its
exact intended configuration and unique cohort marker; its historical outcome
remains unknown. Conflicting or unproved updates remain held. All new work is
recorded separately; the old partial
files and failed outcome are never rewritten. Fresh complete capacity and
native readback are still required before the first controller can launch.

Reused Machines keep their IDs, names and attached physical Volumes. The storage
mode is explicitly `retained-volume-fresh-generation`, not a newly created
Volume. A new exclusive generation directory is mounted over `/data` in a
private mount namespace before the ordinary boot, status server and task
processes start. The previous Volume contents remain outside that task view.
The immutable guest helper checks the generation, owner, namespace and source
bindings. External runtime commands enter that same verified namespace; file
collection resolves the matching generation rather than old `/data` artifacts.
An unavailable isolation primitive or stale binding stops admission before task
execution.

This changes storage reuse, not the original ordered tasks, three repetitions,
600 concurrency, retry budget or execution limits. Old claims, unresolved prior
outcomes and data are retained. Cleanup stops a reused Machine and archives its
current ownership; it does not delete its Machine or Volume or convert an old
failure into a success. A later reuse must prove the latest archived owner and
current native marker, so an older archive cannot reclaim a newer generation.

Successful retained cleanup records the exact stopped successor in the sealed
teardown audit. Lifecycle and terminal publication verify that receipt while
leaving the ownership registry intact. For the next campaign, pass the latest
completed controller's run directory through `--archive-run`; keep older
archives as evidence, rather than offering stale ownership for the same IDs.
The normal fresh capacity check still runs before any new allocation.

If a completed controller never assigned some of its reserved Machines, add
`--unused-reservation-run "$CLOSED_ADMISSION_DIRECTORY"` alongside the original
`--archive-run` inputs. This operand is the outer admission directory containing
the original request and reservation journals. Keep its complete verified
controller archive, launch lineage and raw native receipts available. The CLI
holds any reservation with an assignment, claim or unresolved effect in that
archive at zero unused-reservation credit. Untouched rows retain every original
lineage, wire-receipt and unchanged-native-reservation check. A malformed or
changed untouched row still rejects preparation.

For a controller launched after incomplete-admission recovery, the same unused
and parked operands select the request bound by its closed launch configuration.
The reader verifies that request against the completed recovery receipt and
checks each reservation's actual recovery lane and raw native evidence. It does
not require an alias at the original outer request path or synthesize a closed
original reservation plan. Original interrupted journals and failed outcomes
remain unchanged; this path is available only after verified controller closure.

For a mixed run, include its newly closed archive and the original archive
needed to prove untouched rows' lineage. Claimed rows suppress only older
archives' stale native comparisons. The matching closed archive must independently
prove current ownership before offering such a Machine as an ordinary archived
candidate. Explicit user exclusions apply everywhere. Held IDs and their source
archive hashes remain in the request; no old claim is cleared or granted credit.

When a closed run also has parked, unpublished claim attempts, use
`--parked-reservation-run "$CLOSED_ADMISSION_DIRECTORY"` instead of the unused
option for that same directory. This explicit mode includes the ordinary
untouched checks and may qualify a parked claim only from complete, hash-bound
historical evidence and exact current stopped native state. It never edits the
old attempt, manufactures its missing acknowledgment, or changes its outcome.
Unknown writes stay held. Keep both the original lineage archive and the latest
closed archive in `--archive-run` inputs. Eligibility still grants no quota:
the normal new lease, version-checked reservation and fresh capacity readback
must succeed before the next controller starts.
The old reservation is never cleared or counted directly: only a new exclusive
reservation and fresh native readback can give the new cohort capacity credit.
Explicit `--reuse-exclude-machine` exclusions still apply. Missing evidence
keeps a Machine unavailable; do not edit old requests or native markers.

Retain the CLI's reservation intents, raw responses and readback receipts if an
operation is interrupted. A missing response is an unknown effect, not evidence
that nothing happened. To resume admission, use the same command and all its
original inputs with `--resume-admission "$PRINTED_ADMISSION_DIRECTORY"`.
The CLI verifies the source and input hashes, keeps the first admission's
5400-second clock, and reconciles the same cohort and journals. An ambiguous
operation is never blindly repeated. Once a controller launch is recorded,
this option refuses a second launch; use the printed run directory with
`--status` and keep its existing owner. Never remove an intent, bypass a claim,
or select a new output directory merely to retry an ambiguous operation.

### Launcher credentials and no-effect failures

Both complete `--backend-env` and `--agents-env` inputs are resolved explicitly,
so a sparse harness checkout does not need copied `.env` files. CHECK resolves a
literal GitHub credential using the existing controller precedence (explicit
base64 override, Git credential rewrite, local gh login, process token, selected
complete backend then agents file) before any capacity read or allocation. It
never prints credentials. Only the owned gate receives the selected token in its
process environment; no whole environment/DB variables or secret subset files
are copied and no token is serialized into the launch config.

If the joined gate explicitly refuses a missing GitHub credential before any
export/allocation stage, it writes a private typed preallocation receipt. The
runner binds its exact gate PID, source, reason and exit status, requires the
entire export path to be absent, then records `FAILED_BEFORE_PROVIDER_DISPATCH`
and joins. Missing ownership/intent files or a generic failed gate alone never
prove no effect: ambiguous CREATE/export/provider failures keep their original
live cleanup owner and pending evidence. This terminal classification does not
retroactively relabel an older launch or benchmark outcome.


### Read one bound status observation

From a checkout containing this public helper, use either form:

```bash
python3 scripts/run-original600-controller.py --status --run-dir "$RUN_DIR"
# Equivalent standalone entry point:
python3 scripts/original600-status.py --run-dir "$RUN_DIR"
```

The command defaults to the adjacent `config.private.json`, the complete agents
input path/SHA256 already bound by `authority.private.json`, and a new private
observation file in the run directory. Optional `--config`, `--agents-env` and
`--out-dir` accept explicit physical paths; the selected complete agents bytes
must still match the original authority. A separate output directory must
already exist, be private and belong to the current user. No `.env` file is
required in the source checkout. Keep the selected authenticated `flyctl` on
PATH for canonical session refresh; credentials are never printed.

Run/config/caller/authority/controller/source/epoch bindings are checked before
one bounded read-only guest exec. It uses the exact supervisor-derived campaign
summary path, not a directory scan. Guest Python runs with `-S` because this
payload is entirely standard library. The command cannot signal, cancel,
restart, stop or delete anything. Only its local private observation is written.
An original local terminal or unpublished controller returns without a provider
call. An unpublished supervisor/summary is reported explicitly; transport,
identity, malformed-data or freshness uncertainty never becomes a fake result.

Canonical infra counts deduplicate every attempt with an explicit true infra
flag, including cancelled or unfinished attempts. Terminal attempts with missing/null infra classification are counted
separately as unknown, as are failed jobs without a terminal attempt. A zero
confirmed-infra count never means those unknown jobs were error free. Attempt-record counts are separate from completed attempts;
local terminal and status output never infer benchmark success or full resource
cleanup. This is a one-shot diagnostic, not an automatic threshold owner or
five-experiment qualification loop.

Status also checks the exact log paths listed for this campaign's jobs and
attempts, without scanning other campaigns. A complete archived-reuse claim
trace ending in `late inactive native version observation`, followed by that
task's provisioning failure, counts as original startup-infra evidence once its
pre-claim successor/source-exclusion records bind the source, owner, run, job,
task and attempt; any extant registry metadata must also agree. Copied text before the fleet
header, generic errors and propagated canary failures do not count. The bounded
reader rejects aliases, changing files and oversized inputs; it reports missing
or unreadable evidence as unavailable.

`original_startup_infra_affected_jobs` reports those unique logical jobs.
`combined_infra_affected_jobs` unions them with the unchanged canonical infra
jobs, including across retries. `infra_stop_required: true` means that union has
reached the original 30/600 threshold. A false value only means that the observed
evidence has not reached it; check `startup_evidence_unavailable_jobs` and the
canonical unknown counts before treating coverage as complete. The saved
`original_startup_failure_evidence` binds each finding to its source, epoch,
job, attempt, owner and log/binding-record hashes. It does not rewrite canonical
classification, infer a task result, or certify cleanup. The CLI still does not
send signals; the existing exact-owner cancellation procedure applies.

Each remote status observation retains a private request and raw-response
journal before decoding. A missing or partial response remains explicitly
unknown; an artifact on disk alone is not proof of a complete response.

The payload finalizer retains a verified supervisor `JOINED` observation while
waiting for the original gate and verified export. It does not probe or signal
that retired PID again. Read-only finalizer recovery can carry that observation
only after checking its original raw PROBE, preceding native identity read,
supervisor identity, parent join, and immutable journal. Export, resource release,
and caller-retirement checks still apply; an exit of `-9` is not benchmark success.

After the complete reuse request passes its existing hash, cohort, uniqueness
and task-index checks, allocation retains only the selected row and the fields
needed to produce its unchanged claim proof. The raw request and other rows are
released before creating the native client or waiting on its lease. This reduces
retained per-helper memory; the full-validation parsing peak is unchanged.

Main-thread native lease acquisition and release use the already loaded client
and the same durable raw-response observer. The complete operation retains its
25-second absolute budget and 20-second HTTP timeout; worker threads retain the
bounded, joined child transport. A timeout never retries the write or turns a
saved response into late success. Bound `NativeWireDeadline` startup traces are
reported separately with the native lease outcome still unknown.

The reader also recognizes the direct shared-environment identity refusal while waiting
followed by the canonical no-Machine-started message. That earlier startup
stage is bound through the exact campaign cohort manifest and job PID, because
it has not created a claim yet. It uses the same separate counts and deduplication;
generic environment errors and propagated canary failures remain unclassified.
The combined identity/deadline prepublication message is also unclassified:
that message alone cannot distinguish identity drift from cancellation.

### Continue a bound launch rejected before controller creation

If a corrected host operator must continue an already prepared admission, use
its normal command and complete original inputs with `--resume-bound-launch
"$ORIGINAL_ADMISSION_DIRECTORY"`. Keep the old workload checkout intact and
pass the new operator commit as `--source-ref`. Omit `--run` first for validation.
This mode derives the exact config and absent output from the original launch
intent. It preserves the workload source, reservations, task inputs and original
clock, refreshes read-only capacity, and records the corrected host operator
separately. It does not overwrite the original config or launch intent. Any
existing run output refuses this path unless the specific pre-exec failure below
is proved; otherwise use the existing owner's status.


For the recorded host `Popen` E2BIG failure from operator57e37b5, add
`--prelaunch-failure "$POSITIVE_JOINED_FAILURE_RECEIPT"` to that same bound
continuation command. The receipt must bind the observed joined tool session,
exact synchronous errno7 traceback, original operator source, and the three
unchanged output files; an empty directory or absent PID alone is insufficient.
The old authority's owner must have exited. The CLI retains those files and
writes an exclusive successor receipt, then launches into the printed new run
directory with a fresh capacity check. Keep using the printed `config_path` and
`run_directory` for status; the original workload, reservations and clock remain
unchanged. A consumed receipt or any evidence of an existing gate refuses reuse.
This narrowly supports the recorded pre-exec failure, not arbitrary failed runs.

Controller launch metadata now travels in a deterministic compressed private
file through the gate's existing `--file-local` transport. Command arguments
contain the fixed guest path and content hashes, not the metadata itself. The
host checks compressed size and hash before admission; the guest checks the
compressed and decoded hashes before staging the original files. The corrected
host gate's source/hash is recorded separately when continuing an older
workload. A future synchronous E2BIG error also writes its own positive pre-exec
receipt and restores the host signal handlers without claiming a gate started.

Embedded evidence files are individually compressed before base64 encoding,
then decoded and checked against their original hashes on the guest. When that
envelope exceeds the existing 256KiB config limit, the CLI sends the compressed
files separately in bounded chunks to the exact owned controller. The small
envelope contains their hashes and lengths. The guest publishes a file only
after checking every byte and waits under the original campaign deadline.
Each 32KiB chunk is assembled from indexed 2KiB fragments. The sender checks
the complete serialized exec request against a 6200-byte bound before dispatch,
including command escaping and JSON framing. Existing files and fragments are
accepted only when their exact lengths and hashes match; an unresolved prior
write is never retried as a new operation.
Lost acknowledgements retain their receipts and may only be reconciled by an
exact read; they never cause a blind write retry. The 16MiB decoded input bound
is unchanged. A retained, positively recorded pre-gate
payload-size refusal can use the same `--prelaunch-failure` continuation mode;
the old output remains preserved and the new run path starts with
`run-after-prelaunch-`. The original workload and clock remain bound.
Current operators emit `launch-payload-failure.json` in that original output;
pass its exact path to `--prelaunch-failure` without copying or renaming it.

If an already-created controller rejected the old large exec request before
receiving its payload, or transfer stopped on a read-only identity request after
all earlier writes were acknowledged, keep the original operator alive. The
recovery command uses that same controller, configuration, source and original
deadline:

For a read interruption, retain `payload-transfer.interruption.json` in the
original run directory. This observed receipt must bind the live caller and
tee parent, their pipe/log descriptors, the exact captured exception output,
and its wrapper source. Missing response files alone do not authorize a handoff.

```bash
python3 scripts/cloudbench-resume-controller-payload.py \
  --operator-ref "$EXACT_RECOVERY_OPERATOR_COMMIT" \
  --config "$EXISTING_CONFIG" --config-sha256 "$EXISTING_CONFIG_SHA256" \
  --run-directory "$EXISTING_RUN_DIRECTORY" --check
```

After this local check passes, replace `--check` with `--run` to transfer the
remaining bytes. The command verifies the retained rejection and readback or
the complete acknowledged-write/read-only-interruption history,
original caller and gate, source files, authority and payload hashes. It creates
one durable borrower intent and preserves the original transfer journal. A
successful transfer does not certify task execution or cleanup. An incomplete
borrower intent refuses a fresh transfer attempt; retain its evidence for
reconciliation.

Keep the original operator alive after transfer. From a separate immutable
checkout, capture its live caller and gate identities before the gate exits:

```bash
python3 -S scripts/cloudbench-controller-payload-finalization.py \
  --capture --operator-ref "$EXACT_FINALIZER_COMMIT" \
  --config "$EXISTING_CONFIG" --config-sha256 "$EXISTING_CONFIG_SHA256" \
  --run-directory "$EXISTING_RUN_DIRECTORY"
```

This capture is local and makes no provider requests. With the same arguments,
`--check` validates the captured identities. Once transfer is complete,
`--finalize` observes the original supervisor and gate, verifies the full export,
and invokes the existing controller cleanup helper. It preserves the original
execution deadline and signals only the exact supervisor when cancellation or
that deadline requires it. The original caller is retired only after verified
resource release. The canonical terminal receipt retains the original workload
source and records the separate finalizer. An unresolved prior finalizer or
cleanup intent is retained and never authorizes an automatic repeat.

If that finalizer exited while making only read-only observations, retain its
entire journal and the original capture. A new immutable operator can validate
an explicit continuation without making provider calls:

```bash
python3 -S scripts/cloudbench-controller-payload-finalization.py \
  --check --resume-journal "$EXISTING_RUN_DIRECTORY/payload-finalization" \
  --operator-ref "$EXACT_FINALIZER_COMMIT" \
  --config "$EXISTING_CONFIG" --config-sha256 "$EXISTING_CONFIG_SHA256" \
  --run-directory "$EXISTING_RUN_DIRECTORY"
```

Replace `--check` with `--resume-finalize` after the check passes. The command
requires the former finalizer's process birth to be dead, hashes every prior
journal member, and accepts only exact controller GETs and supervisor PROBEs.
Any prior cleanup or unrecognized effect refuses this route. The continuation
uses a new exclusive journal, binds both operator versions, preserves the old
capture and original deadline, and never repeats an existing supervisor TERM.
An exact native exec `No child process (os error 10)` response to a PROBE is a
recorded read failure that can be observed again; malformed identity responses
remain refusals.

If the canonical cleanup child exited before constructing its API client with
the exact `no Fly credential is available` traceback, preserve its joined
receipt, log and cleanup intent. The finalizer passes the selected credential
from the authority's hash-bound agents input in the child's environment. It
does not depend on a local env-file alias or a login shell.

For the known original operator's pre-client refusal, use the failed child's
exact journal with a new immutable operator:

```bash
python3 -S scripts/cloudbench-controller-payload-finalization.py \
  --check --cleanup-refusal-journal "$FAILED_CLEANUP_JOURNAL" \
  --operator-ref "$EXACT_FINALIZER_COMMIT" \
  --config "$EXISTING_CONFIG" --config-sha256 "$EXISTING_CONFIG_SHA256" \
  --run-directory "$EXISTING_RUN_DIRECTORY"
```

Replace `--check` with `--resume-cleanup` after the check passes. This route
requires the exact known helper, transport and resolver source, the positive
pre-client traceback, the dead child's owned join, unchanged verified export,
and absence of native deletion intents or a release. It preserves the original
cleanup invocation and all old journal bytes and creates one exclusive successor
journal. An unknown or provider-entered cleanup cannot use this route.


### Drain registered orphan owners before completing export

If the original campaign parent has exited and the original deadline has
expired, a verified supervisor JOINED receipt can authorize termination of
only its exact registered fleet controllers. Keep the finalizer alive and
retain the complete pending-export receipt. From the new immutable checkout:

```bash
python3 -S scripts/cloudbench-controller-orphan-drain.py \
  --check --operator-ref "$EXACT_RECOVERY_COMMIT" \
  --config "$EXISTING_CONFIG" --config-sha256 "$EXISTING_CONFIG_SHA256" \
  --run-directory "$EXISTING_RUN_DIRECTORY" \
  --joined-journal "$EXISTING_RUN_DIRECTORY/payload-finalization" \
  --pending "$PRIVATE_COMPLETE_PENDING_RECEIPT"
```

Replace `--check` with `--run` after the local check passes. The helper binds
source, registry, campaign membership, UID and process birth, then sends one
TERM through each exact process descriptor. It does not signal process groups
or unregistered helpers. `--observe` returns retained signal receipts without
repeating TERM; those receipts do not prove every writer has exited.

If the original gate returned export-pending, the export recovery helper uses
the unchanged original collector and caller authority. Its local `--check`
makes no provider requests. Retain the original finalizer, which alone owns
controller cleanup after the verified-export marker appears.

```bash
python3 -S scripts/cloudbench-resume-controller-export.py \
  --check --operator-ref "$EXACT_RECOVERY_COMMIT" \
  --config "$EXISTING_CONFIG" --config-sha256 "$EXISTING_CONFIG_SHA256" \
  --run-directory "$EXISTING_RUN_DIRECTORY"
```

If the live owner's gate returned export-pending without downloading
`export/launch.json` (for example, its watchdog expired while the host was
suspended), `--check` cannot bind the launch. Fetch that record once with
`--fetch-launch` (no `--dead-owner`), then use `--download-verified` when the
remote export already completed. After the original deadline, pass one private
`controller-export-cleanup-window-v1` window (at most one hour, zero credit) via
`--cleanup-window` to each command. The live runner still owns cleanup.
Export recovery streams each member with a pty-free `flyctl ssh console -C
'cat -- <path>'` in 16 MiB writes. `ssh sftp get` wrote 32 KiB blocks, which the
`/project` FUSE run directory absorbed at under 2 MB/s.

After the local check passes, use `--observe` for a read-only readiness check.
A pending result retains the exact writer list without consuming an export
intent; observe again only as needed. Once READY, replace the mode with `--run`
for the once-only export.

Export recovery checks the original driver and command join, preserves the
complete orphan-drain journal, requires the canonical writer check, downloads
into private staging and verifies every original archive member. It publishes
the canonical verified-export marker only after all remote helpers have joined.
An uncertain export dispatch never authorizes repeating that export.

Dead-owner export recovery binds the shard's own deadline. That is the epoch
plus the shard's bound e2e timeout, for example 10020 s for `--timeout 7200`, or
5400 s when unbound.

If a host or service restart killed the operator, a shard's runner and its gate
while the controller was still running, nothing remains to verify the export
or run controller cleanup: the run's pinned disposable helper refuses every
action for a dead cleanup owner. First stop new work through the runner's own
barrier ABORT and wait for the supervisor to report JOINED. Then write one
private `controller-export-dead-owner-window-v1` window per controller: the
ordinary cleanup-window fields (at most one hour, `cleanup_only: true`,
`benchmark_credit: 0`) plus `dead_owner_pid`/`dead_owner_birth` from the run's
`caller.json` and the coordinator's `coordinator_pid`. Add `--dead-owner
--cleanup-window <window>` to the commands above. The tool refuses unless that
exact runner PID/birth and its gate are gone and the coordinator PID is absent.

```bash
recover() { python3 -S scripts/cloudbench-resume-controller-export.py \
  --operator-ref "$EXACT_RECOVERY_COMMIT" --config "$EXISTING_CONFIG" \
  --config-sha256 "$EXISTING_CONFIG_SHA256" --run-directory "$EXISTING_RUN_DIRECTORY" \
  --dead-owner --cleanup-window "$PRIVATE_DEAD_OWNER_WINDOW" "$@"; }
recover --fetch-launch       # the remote launch record the killed gate never downloaded
recover --check              # local only; no provider requests
recover --download-verified  # or --observe, then --run, when the remote export is pending
recover --release            # supervisor JOINED, then the runner's own controller cleanup
```

`--release` probes the supervisor through the runner's exact control path,
records the runner's `cleanup-call.intent.json`, and runs the pinned
`cloudbench-disposable-controller.py cleanup`. The helper source is unchanged;
only its live-owner check accepts the recorded owner after re-proving that the
process is gone. It reconciles the release receipt with the runner's own
reconciliation, rereads the controller Machine and workspace Volume, and writes
`terminal.json` with `DEAD_OWNER_CONTROLLER_RELEASE_VERIFIED` and zero
benchmark credit. Each step journals once and is never replayed.


### Recover a stopped controller's retained export

A host suspension can lose the gate's export download after the on-host
collector already finished; the controller then stops (restart policy `no`)
and every supervisor probe fails. Within about a minute of failed probes after
the gate joins, the runner reads the exact native controller. When the same
instance is `stopped` or `destroyed` and the export is unverified, it writes
`export-recovery-required.json` (`EXPORT_RECOVERY_REQUIRED_CONTROLLER_STOPPED`)
once and stays alive as the cleanup owner. Do not start the controller: its
init reruns the gate script against the evidence volume.

1. Fork the retained workspace volume (`flyctl volumes fork <volume> -a <app>`)
   and mount the fork on a short-lived Machine of the same
   image with an inert init (`sleep`), `auto_destroy` and restart `no`.
2. Download `controller-host-custody/{originals.tar.gz,manifest.json,launch.json}`
   from the fork. Require `sha256(originals.tar.gz)` to equal
   `manifest.archive_sha256`; keep copies under `export/retained-volume-recovery/`.
3. Copy the three files (single-link regular files) into the run's `export/`
   and run the pinned helper with the run's own authority:
   `cloudbench-disposable-controller.py export-ready --authority <run>/authority.private.json --root <source> --directory <run>/export --machine <id> --image <launch.json image>`.
   The unchanged collector `verify()` writes `disposable-export.verified.json`.
4. The live runner re-reads the stopped controller and invokes its canonical
   `cleanup` once, ending with `CONTROLLER_STOPPED_RELEASE_VERIFIED`. Destroy the
   scratch Machine and the fork, then confirm native `destroyed`/`pending_destroy`.

A missing or mismatched archive keeps the receipt open; it never grants credit.

A startup deadline can also fire after the controller was created, before the
gate seals ownership. Its `cleanup-workspace` then refuses the existing
allocation. The runner resolves that exact Machine by its create-intent name,
runs the pinned `seal` once, preserves the refused intent as
`cleanup-call.workspace-refused.json`, resumes probing and writes
`export-recovery-required.json` (`EXPORT_DOWNLOAD_REQUIRED_SEAL_RECOVERED`).
While the controller is still started, download the same three custody files
directly from it (steps 2–3, no fork). The runner then releases it once.

Within a live strict cohort, the fleet shares one successful read-only app-secret
verification. The proof is bound to the campaign owner and process births,
cohort membership, app, source, verifier bytes, complete environment hashes and
selected authentication inputs. It is consumed only while the same owner is
live. Standalone runs keep their ordinary verification. A failed check is never
cached: its stdout, stderr and exit status remain private under the cohort's
`environment-preflight` directory. Waiting and cancellation retain the original
startup deadline and join the owned verifier. This does not refresh app secrets
or infer that a failed read means the app is missing.

Authentication identity follows the canonical verifier's effective credential
selection: a valid explicit benchmark token, config access token, process token,
then the agents env token. It hashes that selected credential and its source.
Unselected credentials and unrelated Fly config metadata do not invalidate a
waiting check. A change to the selected credential, environment files, source
or owner still refuses reuse. A private `identity-mismatch-*.json` receipt records
the differing field names and hashed bindings, without token or config contents.
