---
id: 2026-09-09-clone-source-read-failure-entered-target-reconciliation
date: 2026-09-09
title: Clone failure ownership was classified only after target machine-name reconciliation
surface: infra
component: cloudbench-fleet-clone-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet clone_machine_target entered machine_id_for_clone_name before classifying and durably recording an exact provider-returned target volume
symptoms:
  - "FAIL: source-machine rate-limit rejection crossed into post-mutation clone-name resolution (1 forced inventory refreshes)"
  - "FAIL: volume-only owned audit was rejected before registry reaper; assert 91 == 0"
  - "exact stale-owner registry identity is unsafe"
  - "exact stale-owner cleanup is quarantined pending guest acknowledgement"
  - "driver exited without cleanup acknowledgement"
tags:
  - cloudbench
  - fly-io
  - clone
  - rate-limit
  - ownership
  - preallocation
sources:
  - commit 65cb5c022656ed028d7031bfb57bb8ad12e002ac
  - commit 048872d59cb839c6ea8355441e0d1272306e05f8
  - commit 29687015cd21161079f384f0e922edb8de80517a
  - fleet run 20260909-215629-914100
  - fleet run 20260910-002414-1221609
  - fleet run 20260910-021331-1465409
  - commit 8562f093a
  - commit d8d1dc8dc
  - commit 59307b5aa
  - commit 458f9ae51
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

`flyctl machine clone` failed before target allocation because Fly could not read
the source Machine under its organization rate limit. The controller nevertheless
forced a fresh target inventory read and emitted `unresolved clone name`, adding
provider traffic during the exact rate-limit condition it was meant to absorb.

The deterministic pre-fix command was
`CLOUDBENCH_TEST_CLONE_SOURCE_RATE_LIMIT_REPRO=1 bash scripts/tests/cloudbench-multi-workstream.test.sh`.
It exited 1 with `FAIL: source-machine rate-limit rejection crossed into
post-mutation clone-name resolution (1 forced inventory refreshes)`. The trace
recorded clone status `1`, no authoritative target ID, and
`definitivelyUnallocated=0`, followed by `clone-name lookup entered`, a successful
`generation-0` to `generation-1` refresh, and deadline exhaustion. The refresh
therefore did not fail; it correctly found no target because target allocation
had never started.

## Diagnosis

Critical path:

`fly_with_timeout machine clone <source>` → clone output/status capture →
authoritative target-ID parse → pre-allocation classification → target-name
inventory reconciliation → durable name retirement → retry.

The first bad boundary was classification. `clone_failure_definitively_unallocated`
recognized only `failed to create volume:`. It omitted Fly's exact source-read
failure even though a failed source read necessarily precedes every target
resource mutation. `clone_machine_target` then used only an empty parsed target
ID to enter `machine_id_for_clone_name`; it did not use the already available
command status and phase evidence to gate that post-mutation operation.

Deepest-owned-cause ladder:

- Target reconciliation ran because the output had no target ID.
- A missing target ID was ambiguous because source-read, volume-create, target
  launch, timeout, and post-create response failures all shared one empty-string
  representation.
- The ambiguity persisted because pre-allocation disposition was an ad hoc
  late cleanup predicate rather than one source-aware decision made before any
  target reconciliation.

The deepest owned cause is a lifecycle-contract inconsistency: clone failure
phase and ownership certainty were available but were not the source of truth
for selecting pre- versus post-mutation handling.

Archive searches for `source-machine rate-limit rejection post-mutation
clone-name resolution unresolved clone name` and `fleet clone preflight mutation
boundary provider inventory cancellation ownership` found the 2026-07-15
unthrottled/fixed-retry rate-limit cases and the 2026-07-20 name-only reservation
case. This incident is a relative, not a recurrence: retries and durable
reservations worked, but the phase classifier routed a pre-allocation rejection
through target reconciliation.

## Solution

`clone_failure_definitively_unallocated` now derives one fail-closed disposition
from clone status, exact source identity, and the complete transcript. An
ordinary single terminal error is allocation-free when it proves either that the
exact source Machine could not be read or that target volume creation failed.
Timeouts, mixed transcripts, mismatched source identities, and all later target
failures remain ambiguous.

`clone_machine_target` computes that disposition once, before target lookup, and
uses the same value both to skip post-mutation reconciliation and to retire the
prewritten name/audit record. This unifies routing and cleanup instead of adding
a rate-limit-specific retry branch. It also prevents every nested source-read
failure and definite volume-create rejection from spending an unnecessary
Machines inventory refresh.

The unchanged reproduction exits 0. Its post-fix trace records
`definitivelyUnallocated=1` for attempt 1, contains no
`machine_id_for_clone_name` entry, and then records the successful attempt-2
authoritative ID. The contract also runs unconditionally in the permanent
multi-workstream suite, and the dependency-sync blackbox covers mismatched
source IDs, watchdog timeouts, and mixed error transcripts.

At 10,000 agents, the change adds O(1) local transcript parsing per failed clone
attempt and removes up to one provider inventory refresh per pre-allocation
failure. It adds no channel, subscription, lock, poller, row, or shared mutable
state.

## Recurrence on 2026-09-10

The same lifecycle-contract problem recurred one boundary later. A real clone
attempt returned no Machine ID but did return exact target volume
`vol_vz8m80el8w7dwqxv` in:

`Error: failed to launch VM: insufficient resources to create new machine with existing volume 'vol_vz8m80el8w7dwqxv' (Request ID: 01M24BSMAJSAD16GZG888ECDZG-lax)`.

The focused pre-fix replay
`agents/venv/bin/pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_failed_clone_captures_owned_volume_before_machine_name_reconciliation`
exited 1 with `provider-owned volume failure crossed into target machine-name
reconciliation`. Its runtime call order was `clone-name lookup entered`, then
`volumes destroy`, then `volumes show`.

H1 was confirmed: `clone_machine_target` parsed and recorded the exact volume
only after `machine_id_for_clone_name`. H2 was confirmed: `reap_volume`
redirected every destroy response to `/dev/null`, so the owning boundary could
not distinguish a provider rejection from an accepted asynchronous transition.
H3, loss of exact ownership, was rejected: the replay completed with zero owner
records only after exact lifecycle success, while the live failed run retained
the exact owner and reported that it could not reap the same volume. The
provider-specific reason for the live destroy rejection remains inconclusive
because the pre-fix boundary discarded it; no provider-specific fallback was
added.

The deepest owned cause was still the original one: clone outcome classification
was not one ordered ownership decision. Exact target-resource evidence remained
an ad hoc cleanup predicate below machine reconciliation, so adding the first
pre-allocation classifier did not fix all sibling outcomes.

`clone_machine_target` now classifies an exact provider-returned volume first,
atomically records it in the owner registry, and performs exact-volume teardown
without entering either machine-name lookup path. Only outcomes with neither an
authoritative Machine ID nor an exact volume proceed to machine reconciliation.
`reap_volume` now captures every destroy command's return code and at most 200
response bytes in the owning diagnostic log; failures without a diagnostic log
are surfaced on stderr. Exact lifecycle reads remain the only success authority,
so response capture adds no silent fallback and ownership remains fail-closed.

The unchanged replay now passes with call order `volumes destroy`, `volumes
show`, no clone-name lookup, one durable receipt
`id=vol_vz8m80el8w7dwqxv rc=1 response=<empty>`, and zero owner records only
after the exact `pending_destroy` receipt. A separate permanent case proves a
400-byte provider rejection is truncated in each of six bounded receipts and
that a nonterminal exact lifecycle retains ownership. The replay's empty destroy
response plus terminal lifecycle does not support an additional
provider-rejection fix.

At 10,000 agents, this adds one O(1) local transcript classification and one
short-lived response-capture file per concurrent volume cleanup. It adds no
provider call, shared lock, subscription, row, or fan-in; diagnostic growth is
bounded to six 200-byte excerpts per cleanup.

## Second recurrence on 2026-09-10

The lifecycle-contract inconsistency recurred at stale-owner recovery. Clone
allocation intentionally publishes two exact `owned` identity forms:
Machine-plus-Volume after a successful VM allocation, and Volume-only when Fly
created a target Volume but rejected the VM launch. The audit writer accepted
both, but `recover_registry_audit_only_fresh` still required every `owned`
record to contain a Machine ID. Its sibling shared-audit updater independently
encoded the same obsolete Machine-plus-Volume-only rule.

The unchanged pre-fix command
`/workspace/agents/venv/bin/pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_recovery_hands_volume_only_owned_audit_to_registry_reaper`
exited 1 with `FAIL: volume-only owned audit was rejected before registry
reaper` and `assert 91 == 0`. Runtime instrumentation proved that the v2 owner
identity and dead-owner classification were valid, the recovery lock was
acquired, and audit recovery loaded `disposition=owned`,
`machineId=""`, `volumeId="vol_vz8m80el8w7dwqxv"`. It then emitted
`machine identity invariant rejected audit record`; the registry-reaper entry
event was absent.

This is a second recurrence of the archived lifecycle-contract problem and a
relative at the audit-only recovery boundary. Archive searches for `volume-only
owned audit rejected registry reaper` and `clone allocation audit identity
machine volume stale owner recovery` selected this case plus the
default-volume-list and registry-retirement relatives. The first recurrence
fixed classification order at clone allocation but did not make the resulting
identity algebra authoritative for every later consumer.

The canonical invariant now requires an exact Volume for every `owned` record
and permits its Machine ID to be either absent or valid hexadecimal. Recovery
validates a Machine-plus-Volume identity through the existing audit-first
repair transaction. A Volume-only identity is accepted only when the extant
exact-owner registry record is a regular non-symlink file containing exactly
the matching `name` and `volume_id` fields produced by
`fleet_registry_record_volume`; missing, partial, conflicting, duplicate,
extra-field, malformed, and special-inode identities remain fail-closed. The
shared-audit updater now applies the same Volume-required/Machine-optional
contract.

The unchanged reproduction now passes and its post-fix log reaches
`entered registry clone reaper` in forced mode. The adjacent permanent
fail-closed regression passes six noncanonical forms, while the existing
Machine-plus-Volume crash-window regression remains green. No provider call,
task definition, timeout, or concurrency setting changed. At 10,000 agents,
recovery performs one bounded, local, O(1) validation per volume-only owner
record and adds no provider traffic, polling, shared lock, row, channel,
subscription, or fan-in.

## Third recurrence on 2026-09-10

The lifecycle contract recurred at the outer exact-owner recovery gate.
Controllers intentionally publish every v2 owner with `cleanup_policy=retain`
and `guest-cleanup-unconfirmed`, then authorize reaping only after all token-bound
guest teardown acknowledgements. `recover_exact_stale_fleet_owner` nevertheless
embedded `cleanup_policy=reap` in its registry identity predicate. A canonical
quarantined owner was therefore indistinguishable from malformed ownership.

The caller's exact stale-owner replay in `/tmp/rose-polar-streak-main` exited 1
with `exact stale-owner registry identity is unsafe`. The permanent pre-fix
reproduction,
`agents/venv/bin/pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_recovery_classifies_cleanup_unconfirmed_owner_as_quarantined`,
also exited 1 on that same message. Its hermetic owner contained the production
shape of ten exact records: nine Machine-plus-Volume identities and one
Volume-only identity. Every provider, pool, capacity, audit, and registry reaper
was a fail-if-called stub.

Runtime NDJSON established:

- H1 confirmed: cleanup state was `retain` with the unconfirmed-guest sentinel.
- H2 rejected: `meta` was a regular non-symlink file and version, app, and host
  identity fields all matched.
- H3 rejected: all ten clone records used canonical allocation identities,
  specifically nine Machine-plus-Volume and one Volume-only.
- H4 confirmed: the outer gate rejected solely because `cleanupPolicyReap=0`,
  before audit recovery or any reaper boundary.

The deepest owned cause remained the same duplicated lifecycle algebra. Cleanup
authorization was encoded as an identity-validation field instead of a separate
state transition, so later consumers could reinterpret a valid producer state
as malformed. A `reap` policy with the sentinel still present was also able to
reach audit-only recovery before the inner clone reaper finally refused it,
despite the producer's fail-closed transition ordering.

`fleet_registry_cleanup_state` is now the shared classifier for stale-owner
consumers. `reap` without the sentinel is the only authorized recovery state;
`retain` without the sentinel remains intentionally retained; and either known
policy with the sentinel is canonical quarantine. Unknown policies remain
unsafe. Exact recovery validates regular-file identity first, then reports a
distinct non-success quarantine result before owner probes or any reaper. The
generic successor scan uses the same classifier, so the intermediate
`reap`-plus-sentinel transition cannot cross audit or provider cleanup.

The unchanged focused reproduction now passes while retaining all ten records,
the sentinel, and every ownership handle with no mutation stub called. The
existing full fake-provider cancellation scenario still requires a nonzero
detached wait, zero provider reap calls, and retention of the exact Machine,
Volume, registry, quarantine sentinel, and capacity reservation; it now asserts
the explicit quarantine diagnostic instead of the false unsafe-identity one.
No provider resource, benchmark task, timeout, or concurrency setting changed.

At 10,000 agents, classification is one O(1) local policy/sentinel read per
owner encountered. It adds no provider call, poll, channel, subscription, row,
shared lock, mutable global, or fan-in; recovery remains independently keyed by
the exact fleet-owner token.

## Fourth recurrence on 2026-09-10

The lifecycle contract recurred at the next owned boundary after quarantine
classification was corrected. Exact owner
`03596f65144d485f8a667fc31f7e3cc6` retained nine started Machines plus one
pending-destroy Volume after its controller received the required TERM and its
30-second guest cleanup attempt could not receive acknowledgements. Retaining
`cleanup_policy=retain` plus `guest-cleanup-unconfirmed` was safe, but
`--recover-stale-owner` had no sanctioned transition out of that canonical
state.

The owner metadata preserved run `20260910-021331-1465409` under
`/tmp/rose-polar-streak-main/.context/fleet/capability-stability-proof/capability-stability-20260910021331-1465395/runs`.
Its ten exact clone records contained nine Machine-plus-Volume identities and
one Volume-only identity. Each configured guest output retained `.cid` and
`status-proxy.port`; the original local status proxies no longer existed.

The first unchanged pre-fix reproduction was
`agents/venv/bin/pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_recovery_reconnects_quarantined_owned_guests_before_provider_reap`.
It exited 1 through `exact stale-owner cleanup is quarantined pending guest
acknowledgement` without requesting any guest shutdown. That proved the
deadlock at the transition owner, independently of Fly.

The next-deeper pre-fix command was
`agents/venv/bin/pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py
-k 'forced_exact_reaper_uses_only_owned_machine_ids_and_exact_volume_ids or
exact_recovery_entrypoint_has_no_global_machine_or_proxy_sweep'`. It exited 1:
the forced reaper emitted `could not verify owned fleet machine
deadbeef000001`, and the entrypoint still contained both `machines list` and
`reap_orphaned_fleet_proxies`. The first recovery draft therefore reconnected
guests but still discovered or swept app-wide neighbors before and after the
exact owner boundary.

Critical path:

`--recover-stale-owner <exact-token>` → validate same-host dead controller →
read only that registry and audit → map each Machine record one-to-one to its
run output → exact `machine status <id>` state/name/private-IP read → exact
`machine status <id> -d` mount/token/remote-port read → reconnect one existing
data-plane proxy per exact Machine → token-bound `POST /shutdown` → require
`GET /shutdown-health` HTTP 204 for every guest → fsync each confirmation →
atomically publish and fsync `cleanup_policy=reap` before removing and fsyncing
the quarantine sentinel → exact-ID Machine/Volume, pool-claim, primary-capacity,
and audit reaping.

The deepest-owned-cause ladder was:

- Quarantine had no recovery transition because guest acknowledgement existed
  only in the dying controller's live proxy/process state.
- The first transition draft reconstructed that state from app-wide
  `machines.json`, provider Machine lists, name resolution, pool/capacity scans,
  and an orphan-proxy sweep.
- Those global sources were unnecessary because the exact registry, owner audit,
  per-output `.cid`, and exact Machine config already formed a complete
  token-bound recovery capability.
- The missing invariant was that an exact-owner command must derive every read,
  side effect, and cleanup target from one sealed owner record before crossing
  that target's boundary.

The problem class remains a lifecycle-contract inconsistency. Durable ownership
was exact, but cancellation recovery did not use that exact capability as the
sole source of truth.

The recovery path now validates regular non-symlink owner/run/output metadata,
requires a complete one-to-one registry-to-`.cid` mapping and valid local proxy
port for every Machine, and ignores canonical Volume-only records only for the
guest phase. It validates each live Machine by exact ID, requires state
`started`, exact registry name, private IP, exact mounted Volume, safe barrier
token, safe guest run token, and safe remote status port. Every configured
Machine must share one barrier token.

It reuses the existing data-plane proxy and
`cloudbench_confirm_guest_shutdowns` contracts. Requests are sent in parallel
before polling; HTTP 202/204/409 only means shutdown was requested, while
`/shutdown-health` HTTP 204 is the sole acknowledgement. No marker is fabricated.
Only after every marker is fsynced does the registry publish and fsync the
ordered `reap`-then-sentinel-removal transition. Missing, malformed, absent,
mismatched, proxy-start, token, transport, or non-204 evidence leaves the owner
quarantined. Failed acknowledgement also releases only the exact temporary
proxy PIDs and token-bound listed port leases; it never short-circuits local
cleanup or scans neighboring leases.

Forced provider reaping now uses `machine status <exact-id>` and exact config
reads. Volume-only records destroy only their recorded Volume and never resolve
their clone name. V2 pool claims come only from the owner's audit, capacity
cleanup addresses only deterministic `<owner>-primary`, and the exact
entrypoint derives the warm-source guard from that owner audit plus exact source
config. It performs no Machine inventory, orphan-proxy sweep, neighbor claim
scan, or reservation-directory scan. Autoscaler temporary probes are unchanged.

The original recovery reproduction now passes. Its six NDJSON events prove the
ordering: H6 validates two exact local mappings; H12 validates two exact-ID
Machine states/configs; H7 reconnects two exact proxies; H8 records two
token-bound shutdown-health acknowledgements with status 0; H9 durably reaches
`cleanupState=reap`; only then does H10 enter the exact provider reaper.

Permanent fail-closed coverage additionally exercises missing/malformed and
mismatched `.cid`, missing/malformed `status-proxy.port`, absent/malformed exact
Machine status, missing/malformed tokens and config, mounted-Volume mismatch,
proxy startup failure, non-204 shutdown health, mixed
Machine-plus-Volume/Volume-only ownership, Volume-only audit recovery,
all-or-nothing proxy-port batch publication, exact capacity/port neighbor
preservation, and exact v2 pool-claim selection. The complete provider-free
suite passes: `266 passed` from
`agents/venv/bin/pytest -q
agents/benchmarks/cloudbench_dependency_sync_test.py`; `bash -n
scripts/run-bench-fleet` also exits 0. No provider resource, benchmark task,
timeout, or concurrency setting changed.

At 10,000 agents, recovery is O(records in the one exact owner): one bounded
local mapping read, two exact-ID provider reads, one temporary proxy, and one
shutdown/health stream per configured guest. Volume-only, pool, capacity, port,
and final reaping touch only IDs or files named by that owner. There is no
app-wide provider list, cross-owner resource scan, subscription, channel, row,
or global result fan-in.

## Fifth recurrence on 2026-09-10

The exact-owner transition reached its first live Machine read but classified
Machine `2862102a194e38` as `absent or unreadable` before starting any recovery
proxy. The exact command itself was healthy: both that Machine and sibling
`84ed277b490668` returned status 0 with matching started state, exact registry
name, and private IP under `flyctl v0.4.100`.

The instrumented unchanged owner recovery recorded H11 `status=0`, followed by
H13 for the rejected Machine with `providerStatus=0`, `outputBytes=1738`,
`hasEqualsRows=0`, and `hasTableRows=1`. This rejected provider absence,
authentication failure, and exact-identity drift. `registry_machine_details`
was the first bad boundary: its human-display parser recognized only legacy
`key = value` VM rows, while current Fly renders `key │ value`. The exact status
read succeeded, but the parser produced no VM identity fields and returned
unsafe status 2; the caller combined statuses 1 and 2 into the observed message.

The deterministic recovery fixture was changed only from legacy equals rows to
the current Fly table rows. Before the parser fix,
`agents/venv/bin/pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_recovery_reconnects_quarantined_owned_guests_before_provider_reap`
exited 1 on `exact owned Machine deadbeef000001 is absent or unreadable`.
After the fix, the unchanged command passes and its logs proceed from two H13
status-0 table reads through H6/H12 exact mapping and configuration, H7 exact
proxies, H8 token-bound health, H9 durable reap authorization, and H10 provider
reaper entry.

The parser now strips terminal styling, isolates exactly one `VM` section from
the unrelated event-log table, and accepts either the legacy `=` format or
current `│` format only when every VM row uses one consistent separator.
Duplicate fields, mixed formats, missing sections, mismatched IDs/states/names,
invalid private IPs, and malformed rows remain unsafe. The provider call remains
`machine status <exact-id>`; no inventory, name resolution, fallback, or
neighbor read was added.

The full provider-free cloudbench suite passes all 266 tests and shell syntax
validation passes. The retained real owner has not been rerun after the fix, so
its guest acknowledgements and provider teardown remain pending the explicit
verification rerun.

At 10,000 agents, parsing remains O(lines in one exact Machine response) and
recovery still issues the same two exact-ID reads per owned guest. The change
adds no provider call, app-wide read, poller, lock, row, channel, subscription,
shared state, or fan-in.

## Sixth recurrence on 2026-09-10

The exact-owner recovery transition validated its warm-source guard and every
owned guest, reconnected all exact status proxies, and then exited 127 with
`cloudbench_confirm_guest_shutdowns: command not found`. Bash executed the
top-level `--recover-stale-owner` entrypoint before reaching the one shared
guest-shutdown function definition later in `run-bench-fleet`. No shutdown
health acknowledgement or provider cleanup could occur.

The unchanged pre-fix command was
`CLOUDBENCH_TEST_EXACT_RECOVERY_ORDER_ONLY=1 bash
scripts/tests/cloudbench-multi-workstream.test.sh`. It exited 1 after the real
immutable script snapshot reported line 5923 `command not found`. NDJSON events
proved the earlier boundaries were healthy: H11 resolved the warm identity with
status 0, H13 read current table-form Machine status with provider status 0, H6
and H12 validated one exact guest, and H7 reconnected one exact proxy. H8 then
recorded status 127. The extracted-function Python regression remained green
because its hand-assembled signature list placed
`cloudbench_confirm_guest_shutdowns` before
`fleet_recovery_reconnect_guest_shutdowns`, reversing production source order.

Archive searches for `cloudbench_confirm_guest_shutdowns command not found exact
stale owner recovery` and `bash function definition entrypoint source ordering
extraction test` selected this case and the 2026-07-21 shell-helper extraction
case. This incident is a recurrence of the exact recovery lifecycle work and a
relative of the extraction-test case: production had a real ordering defect,
while the owning regression reconstructed a different ordering and hid it.

The one shared `cloudbench_confirm_guest_shutdowns` definition now appears
before `fleet_recovery_reconnect_guest_shutdowns` and therefore before the early
exact-recovery entrypoint. The later duplicate location was removed rather than
copying the helper. Normal EXIT cleanup still calls the same function body.

The permanent shell regression now drives a real detached controller through
allocation, durable exact guest publication, SIGKILL, immutable-snapshot
`--recover-stale-owner`, authenticated shutdown health, and exact provider
reaping. Its fake provider now emits the same exact status/config/absence
contracts consumed by production. The unchanged focused command exits 0; H8
records shutdown status 0, H9 records `cleanupState=reap`, and H10 enters the
provider reaper only afterward. The complete multi-workstream suite passes,
including every mandatory-autoscaler failure probe; the full dependency-sync
suite passes all 266 tests; the fleet infra-canary structural suite and Bash
syntax checks pass.

At 10,000 agents, this is a source-order-only move with zero added runtime work:
the same O(guests in one exact owner) shutdown calls and exact-ID provider reads
execute once. It adds no provider call, poller, lock, row, channel, subscription,
shared state, or fan-in.

## Seventh recurrence on 2026-09-10

The real recovery of exact owner `03596f65144d485f8a667fc31f7e3cc6`
validated all nine registry-to-output mappings, current Machine states, mounted
Volumes, run tokens, and exact data-plane proxies. Guest cleanup then failed in
two forms. Six `POST /shutdown` requests settled at HTTP 500 after
`cloudbench-driver.state=exited`; three remained HTTP 202 with
`cloudbench-driver.state=running` through the recovery deadline. All nine
runner cleanup-status reads and token-bound acknowledgement reads returned 404.
The six bounded `bench.log` tails ended with
`FATAL: benchmark root cleanup was not confirmed; refusing guest cleanup
acknowledgement`, `FATAL: could not publish guest cleanup acknowledgement`, and
`driver exited rc=1`. H8 recorded `guestCount=9,status=1`; no H9 authorization
or H10 provider reaper event followed, so the exact owner remained quarantined.

The critical path was:

`cloudbench-boot.sh` asynchronous driver launch → driver
`run_with_heartbeat` benchmark launch → authenticated `/shutdown` TERM to the
exact driver → driver INT to the exact runner → `run_single_task` cancellation
archive/payment/root DELETE → atomic run-level cleanup status → driver token and
state validation → root-owned cleanup evidence and acknowledgement → HTTP 204.

Two independent boundaries were wrong. First, the non-interactive boot
supervisor launched its driver as an ordinary background job. Bash therefore
started that driver with SIGINT and SIGQUIT ignored; the driver's inner
`set -m` could not reset a disposition ignored at shell entry, and the runner
inherited it. Second, this branch exported
`BENCHMARK_INTERRUPT_CLEANUP_STATUS_FILE` and required its clean token-bound
value in `cloudbench-run.sh`, but `run_benchmark.py` contained no consumer,
retained cancelled roots because `--keep-failed-agents` was set, and accepted
any DELETE response as success. Commit `533001686` had implemented the runner
half on a sibling branch; commit `ac6e6d72b` later imported the driver
requirement without that half. Extracted-function and structural tests did not
execute boot, driver, and runner together, allowing the split contract to ship.

The unchanged owning-boundary command was:

`agents/venv/bin/pytest -q
agents/benchmarks/cloudbench_dependency_sync_test.py::test_real_boot_driver_interrupt_requires_canonical_runner_cleanup_ack`.

Before the fix it exited 1 with HTTP 202. The actual signal-target record was
`ignored=0000000001001006 caught=0000000000000000`; the driver recorded a
successful `kill -INT`, but no H14 runner-cancellation event followed. A direct
runner-only cancellation then recorded H14 with both contract variables
configured and H16 `deleteConfirmed=false`, while no status file existed. This
confirmed both failures without provider mutation. H17 was confirmed for the
six exited guests: a signal attempt permanently selected the strict status
check, and the absent runner publisher made acknowledgement impossible. H18
was resolved before implementation: `/data` is root-owned and the driver
explicitly chowns only narrower paths, so having the `rose` runner atomically
replace a root-level status file was not a production-safe contract.

The boot supervisor now enables monitor mode only around the real driver launch,
giving the driver and its descendants a normal interrupt disposition. The
runner publishes atomic, file-and-directory-fsynced `pending|clean|failed`
status under its already runner-writable context directory, counts every
interrupted root, overrides diagnostic failed-agent retention only for
owner-requested cancellation, and requires the canonical root DELETE to return
HTTP 204. Completion is recorded only after the task's full `finally` cleanup.
At process exit the runner publishes `clean` only when every started cleanup
completed; all other states remain fail-closed.

The root driver validates the private status token and state, mirrors that exact
runner-produced evidence to the existing root-owned public status path, and
publishes the cleanup acknowledgement only for `clean` plus the exact run token.
It never synthesizes a runner verdict. Boot now appends status/ack presence to
`bench.log` before sealing `driver.state=exited`, so future recovery has durable
source-boundary evidence even when acknowledgement is absent.

The unchanged owning command now exits 0. Post-fix H15 records
`ignored=0000000001001000 caught=0000000000000002`; H14 proves cancellation
reached the runner with the contract configured; H16 proves
`deleteConfirmed=true`; the final H14 records `state=clean,started=1,completed=1`;
H17 records clean state plus token match; and H18 records driver status 0 with
both public status and acknowledgement present. The permanent regression
executes the actual boot script, actual driver signal trap and 30-second
heartbeat semantics, and actual runner cancellation/DELETE/finalization
functions. The complete lifecycle suite passes all 267 tests, runner contract
tests pass 14/14, status-service shutdown passes, fleet infra-canary structural
checks pass, and the multi-workstream suite passes every scenario.

The real retained owner has intentionally not been rerun: provider cleanup
remains the owner's verification action. Exact-owner quarantine and the
guest-ack-before-provider-reap ordering are unchanged.

At 10,000 agents, each active guest has one isolated driver, runner, and
constant-size pair of status files. Cancellation adds O(interrupted roots in
that one runner) local counter updates and one canonical DELETE per root; there
is no cross-agent channel, subscription, table scan, shared lock, provider
poll, or global fan-in.

## Eighth recurrence on 2026-09-10

The post-fix controller was rerun against the same nine pre-fix guest snapshots.
As expected, no guest could retroactively acquire the corrected boot, driver,
or runner code. Six exact `/shutdown` requests again returned HTTP 500 after
driver exit, three exact guests remained pending through the acknowledgement
deadline, and recovery exited 1 without entering the reaper. This rejected the
hypothesis that controller retry alone could make an old guest publish a new
top-level acknowledgement.

The retained owner still names exactly nine Machine-plus-Volume records and one
Volume-only record. The nine Machine IDs are `865463eb495118`,
`d896269c97e048`, `e82e291c433d58`, `28625d2c491758`,
`813962a40d3148`, `84ed277b490668`, `83e202b7737028`,
`2862102a194e38`, and `2862595b6d4328`. Their Volumes are respectively
`vol_vjyqyjyy6eo69dmv`, `vol_vdeje7emwew5y5k4`,
`vol_v3g1gogd8eg28mw4`, `vol_vdeje7empdn000k4`,
`vol_r1j2jkjjp5k1kl3r`, `vol_vgnpnznj6p6xdpj4`,
`vol_v3g1gogl7y0q5314`, `vol_r68w87833g9deyd4`, and
`vol_vgnpnznjg87o2gj4`; the Volume-only identity is
`vol_42kekpk3pk98yz84`.

Durable, per-output runner/backend evidence names 28 exact Kernel sessions:

- `polar-odysseys-b1bd700090c2`: `q2hvke6g3qpxawls7m3yhszg`,
  `hvvnzrmo4zp9nt2fdk2icbkq`, `iykspsm83664aaqcx9remu7q`,
  `auoqogx5ck38anof6v9a5918`, `ubxo30kk209qx8ydmowkczx2`,
  `tj6k6vetgv600e5jgr4gsfuu`, `tn07sfczffwej3qibyy3u0uf`,
  `vko6vhpj3hexb4r0xhtsjhkl`, `m5mtf56d9mny3pp3lye4nm17`, and
  `rxo3dbijoilelkc5rf2h86zv`.
- `polar-odysseys-437482860f2b`: `szf2i7xhtpj9e2ndkua3rgdr`.
- `polar-odysseys-5aaab80dfeee`: `e31wbs1h879em8xpmtlodmdp`,
  `hcv6elx8j1r7p1yxh594yua8`, `sln3cubtdofy060x9oo3ii9g`, and
  `x856n4tq8d102lhw6kfzha2b`.
- `agent-payment-abandonment`: `vi7qbg1klnml068ofov0oao3`.
- `polar-odysseys-47b251d71185`: `ouemy82vhbr4jv4nqc0zzhmn`,
  `jffp8rep2504828k1jabkskc`, `th7doep6r0cb9wpqyoz7b2so`,
  `ib7tdk7j17bzlavopgnz0hb1`, and `j0wpf1jbnicxluql9gx0jtij`.
- `polar-odysseys-753ce2163f6e`: `hc0pd5kq7spf9fslbf6tysys`.
- `polar-odysseys-7e31dc76193f`: `tj0d946jze5lkm801z49bakj`,
  `v8kdet6i4j30kq5by439jtxk`, `tx2y33la58weixtemlv9qfp0`,
  `ojp37z3fxjoa2f5dyrhb4e9v`, `s7c7qp9xih5a55vxc3dwcsfy`, and
  `s5o0mlw9m6ax4oao6rg5cmit`.

No exact provider session ID appears in the durable evidence for
`parallel-tool-calls` or `polar-bu-066`. That is a real trace-capture gap, not
proof that those guests own no external session. Recovery must therefore find
a valid private runner cleanup receipt for each of those outputs or leave the
entire owner quarantined. A provider resource created before its ID reached
durable evidence cannot be discovered safely without the prohibited
cross-owner provider inventory.

The first bad recovery boundary was the assumption that only the mirrored
top-level guest acknowledgement could authorize teardown. The guest already
had two narrower durable authorities that the controller did not consume: the
runner's token-bound `state=clean` receipt, when present, and the exact provider
IDs in that output's immutable run record and backend log. This is another
recurrence of the duplicated lifecycle contract: production could produce
exact cleanup evidence, but stale-owner recovery had no source-bound,
idempotent transition from that evidence to its existing exact reaper.

Recovery now first requests the unchanged top-level acknowledgement. On
failure, it reads the exact private runner receipt through that guest's existing
exact proxy and accepts only canonical version, run-token, and `clean` fields.
If no runner receipt exists, it transfers a bounded quiescence helper to that
exact Machine, requires a stopped services manifest, absent exact service PIDs,
a closed backend port, and immutable hashes of the one-task `run.json` and
backend log. It extracts only Kernel/Steel IDs present in those sealed files,
calls only the provider-specific delete/release endpoints for those IDs, and
accepts only explicit success/already-absent responses. The controller writes
an atomic, fsynced receipt bound to owner, run, bench, Machine, run token,
manifest, evidence hashes, and every exact provider response. It publishes the
existing per-output cleanup confirmation only after that receipt validates.
Any missing output, identity, receipt, evidence file, exact session ID,
quiescence condition, credential, transport response, or provider result keeps
the owner quarantined; driver exit is never cleanup evidence.

The deterministic pre-fix regression is
`agents/venv/bin/pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_pre_fix_guest_runner_receipt_authorizes_exact_reaper`.
Before the fix it exited 1: the non-204 top-level acknowledgement retained the
owner despite a canonical private runner `clean` receipt. The unchanged test
now passes, with H8 status 1 followed by H19 runner-receipt validation, H22
recovery success, H9 durable `reap` authorization, and H10 exact reaper entry.
Adjacent provider-free tests prove exact-ID-only Kernel/Steel calls,
idempotency, rejection of incomplete runner evidence, and quiescence evidence
hashing. The focused suite passes 5 tests, the complete dependency-sync suite
passes all 271 tests, Bash syntax and status-shutdown suites pass, fleet
infra-canary passes, and the complete multi-workstream lifecycle suite exits 0.

`run-bench-cloud` now includes both recovery helpers in the immutable boot
`--file-local` bundle and legacy SFTP bundle, and the controller script snapshot
includes them. Newly cloned guests therefore receive the same helper versions
used by their controller. No benchmark task, timeout, concurrency, evaluator,
or provider behavior changed. The retained real owner was not cleaned or
reaped; that remains the user's explicit rerun.

At 10,000 agents, recovery remains O(resources in one exact owner and one
output): one exact proxy read or one exact Machine SSH action, bounded evidence
reads, and one idempotent call per durably named provider session. It adds no
inventory, neighboring-session read, global sweep, fan-in, shared lock,
subscription, row, channel, or polling work.

## Human feedback

The user required both occurrences to receive the deepest generalizable ordering
fix, the exact unchanged reproduction to pass, permanent consistently-run
coverage, an RCA case/index update, and bounded owning-boundary destroy-response
capture. They prohibited weakening fail-closed ownership, changing benchmark
tasks/timeouts/concurrency, provider mutations, and commits.

For the second recurrence, the user required `owned` identities to accept
exactly the Machine-plus-Volume and Volume-only forms already emitted by clone
allocation while keeping empty and ambiguous forms fail-closed. They required
the existing regression to remain unchanged, the correct archive case to be
appended rather than forked, focused and full suites plus archive validation,
preservation of autoscaler probes and stability-proof edits, and no provider
resource mutation or commit.

For the third recurrence, the user required the deepest owned fix, a permanent
failing-before/passing-after cloudbench regression, preservation of existing
autoscaler probes, and the exact test commands and results. Tests could not
mutate provider resources or change benchmark tasks, timeouts, or concurrency.

For the fourth recurrence, the user required recovery to reconnect only exact
owned live guest Machines, use the existing token-bound shutdown/health
contract, durably prove every acknowledgement before provider reaping, preserve
mixed and Volume-only registries, and fail closed for every incomplete mapping,
token, proxy, or HTTP result. They prohibited fabricated acknowledgements,
neighbor listing/sweeping, out-of-owner cleanup, provider mutations during
tests, and task/timeout/concurrency changes; the real owner remains for the user
to recover and verify before instrumentation cleanup.

For the fifth recurrence, the user required instrumentation of the exact
Machine lookup, a deterministic regression for why
`2862102a194e38` was classified absent/unreadable, and a fix that preserves
fail-closed identity, exact-owner boundaries, autoscaler probes, and all
task/timeout/concurrency settings.

For the sixth recurrence, the user required a general function-definition /
entrypoint ordering fix with one shared implementation, a regression that
executes production source order rather than extracted functions, full relevant
suites, unchanged fail-closed semantics and autoscaler probes, a pushed branch,
and the exact real-owner rerun command.

For the seventh recurrence, the user required bounded evidence from only the
nine exact guests, an actual boot/driver-trap regression, the deepest owned
cleanup-ack repair, persistent source evidence, and preservation of
exact-owner quarantine with no fabricated acknowledgement. Provider cleanup
remains exclusively the user's rerun action; task definitions, timeouts, and
concurrency are unchanged.

For the eighth recurrence, the user required a controller-owned recovery path
for the immutable pre-fix guests: use an exact private runner receipt when
available, otherwise clean only exact provider IDs from durable per-output
evidence, persist positive receipts, and authorize the existing exact reaper
only after all nine outputs are proved clean. They prohibited inferring cleanup
from driver exit, fabricating acknowledgements, listing or sweeping neighboring
resources, providerful tests, and any task, timeout, or concurrency change.
They retained ownership of the real cleanup command and required any missing
provider ID to be reported as a trace-capture gap.

## Reusable lesson

Classify resource-creation failure phase once before reconciliation, and use that same source-aware disposition for both control flow and durable ownership retirement.
