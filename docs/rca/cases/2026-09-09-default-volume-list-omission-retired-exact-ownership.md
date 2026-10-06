---
id: 2026-09-09-default-volume-list-omission-retired-exact-ownership
date: 2026-09-09
title: Default Fly volume-list omission retired exact teardown ownership before the volume reached a terminal lifecycle state
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet volume_inventory_contains_id treated omission from Fly's default app-wide volume list as authoritative exact-volume absence
symptoms:
  - "FAIL: teardown sealed destroyed-verified-absent after two transient absences; vol_restoring reappeared provider-visible as detached created"
  - A fresh-clone audit says destroyed-verified-absent while the exact volume later appears detached in created state
  - Dead fleet-owner registries remain after provider teardown
tags:
  - cloudbench
  - fly-io
  - volume-lifecycle
  - teardown
  - ownership
  - resource-leak
sources:
  - commit 584e42e85
  - task restoring-volume teardown reproduction
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

Cloud Fleet teardown could publish `destroyed-verified-absent` and remove its
only exact registry record while a snapshot-restoring volume still existed.
The unchanged focused command
`CLOUDBENCH_TEST_RESTORING_VOLUME_REAP_REPRO=1 bash scripts/tests/cloudbench-multi-workstream.test.sh`
exited 1 before the fix with `FAIL: teardown sealed
destroyed-verified-absent after two transient absences; vol_restoring reappeared
provider-visible as detached created`.

The captured runtime sequence was: exact volume `vol_restoring` entered teardown
in `restoring`; Fly accepted destroy; two successful default-list reads returned
`[]`; `reap_volume` returned success; the caller retired the audit and registry;
then the same ID appeared detached in `created`. The always-run Python lifecycle
replay failed independently with the same string and subprocess exit 90.

Read-only inspection of the affected provider records found nine exact IDs in
`pending_destroy` and one companion ID in `destroyed`, while the default list
had omitted those destroyed states. Exact `flyctl volumes show <id> --json`
returned each lifecycle state. All ten audited Machines were absent. Eight
owner registries had dead PID births; seven were empty and one retained a
name-only clone record.

## Diagnosis

The critical path was `durable exact volume ID → reap_volume destroy request →
volume_inventory_contains_id default app-wide list → boolean absence →
reap_volume success → destroyed audit publication and exact registry removal`.
The first wrong value was the helper's “authoritatively absent” result. Fly
documents that its default volume list hides destroyed states, and the runtime
replay also proves that a restoring volume can be omitted temporarily. Therefore
the list answered an inventory-presentation question, not the exact resource's
lifecycle question.

The preceding fix in commit `584e42e85` counted two consecutive omissions. That
guard recurred because repetition cannot make a non-authoritative observation
authoritative. The deepest owned cause was a contract mismatch: teardown
collapsed an exact resource lifecycle into membership in a filtered app-wide
projection, then used that surrogate to retire durable ownership.

H1, transient default-list omission, was confirmed by two valid empty samples
followed by the same ID in `created`. H2, destroy success is only request
acceptance, was confirmed by destroy exit 0 followed by reappearance. H3,
transport or malformed JSON caused the absence, was rejected because both
samples were valid successful JSON arrays. H4, cleanup retired ownership from
the bounded samples, was confirmed by the terminal audit and absent registry
record before the conflict. H5, audit concurrency caused the conflict, was
rejected by the deterministic sequential replay.

## Solution

`volume_inventory_contains_id` now performs an exact
`flyctl volumes show <id> --json` read and validates both the returned ID and
state. `reap_volume` retries live and transitional states, retains ownership on
unknown or malformed reads, and succeeds only for explicit
`pending_destroy`/`destroyed` states or an exact-ID `volume not found` response.
The absence counter and app-wide volume-list scan were removed.

The unchanged provider sequence and failure assertion remain in
`scripts/tests/cloudbench-multi-workstream.test.sh`. The always-run lifecycle
suite in `agents/benchmarks/cloudbench_dependency_sync_test.py` covers
`created`, `restoring`, `scheduling_destroy`, `recovering`,
`pending_destroy`, `destroyed`, exact absence, provider failure, malformed JSON,
and wrong-ID responses. It also asserts teardown never performs an app-wide
volume list. At 10,000 agents, each owned volume performs at most six bounded
O(1) exact-ID reads; it no longer downloads or parses an O(all app volumes)
projection per volume.

## Human feedback

The user required the deepest generalizable fix without changing benchmark
definitions, timeouts, or concurrency; required the reproduction scenario and
failure assertion to remain intact; required permanent always-run coverage and
full tests; and prohibited provider mutations and commits during this work.

## Reusable lesson

Retire exact resource ownership only from that resource's explicit terminal lifecycle receipt, never from omission in a filtered aggregate list.
