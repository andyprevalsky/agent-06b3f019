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
  - "unresolved clone name 'cloudbench-…'; inspect with: flyctl machines list"
  - "Error: could not get machine 683e47df5094d8: failed to get VM 683e47df5094d8: resource_exhausted: rate limit exceeded"
  - "FAIL: volume-only owned audit was rejected before registry reaper; assert 91 == 0"
  - "exact stale-owner registry identity is unsafe"
tags:
  - cloudbench
  - fly-io
  - clone
  - rate-limit
  - ownership
  - preallocation
sources:
  - commit 65cb5c022656ed028d7031bfb57bb8ad12e002ac
  - fleet run 20260909-215629-914100
  - fleet run 20260910-002414-1221609
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

## Reusable lesson

Classify resource-creation failure phase once before reconciliation, and use that same source-aware disposition for both control flow and durable ownership retirement.
