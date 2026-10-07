---
id: 2026-10-06-campaign-seed-proof-empty-pg-major-default
date: 2026-10-06
title: Campaign seed proof treated an empty PG-major differently from the fleet default
surface: harness
component: cloudbench-campaign-seed-preflight
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench-campaign-seed.py fixture records an empty PG-major before the fleet shell applies its existing 15 default
symptoms:
  - parent proof disagrees with fleet PG-major default
  - campaign seed proof does not own this fixture/controller
tags:
  - cloudbench
  - campaign
  - seed-proof
  - pg-major
  - environment-default
sources:
  - commit 5c1fc870c237908db79191ed6c6ae5de5dd96e48
  - PR #1424 CodeRabbit review 4201671716
  - plan:.context/fresh-claude-grouped50-20261006/final-review-seed-proof-packet/source-review.safe.json
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py
status: open
---

## Problem

An exported empty `CLOUDBENCH_GUEST_PG_MAJOR` made the parent prepare a complete
canonical GET under a token without a PG-major component. The fleet's existing
`${CLOUDBENCH_GUEST_PG_MAJOR:-15}` then selected PG15. Recomputed fixture
identity differed and the unchanged proof validator rejected admission.
The new owning loopback test failed on frozen5c1 (exit1,2.918s) with
`parent proof disagrees with fleet PG-major default`.

## Diagnosis

Path: parent environment → fixture identity/token → completed full GET and
sealed proof → fleet shell default → consume fixture equality. The first bad
data is the parent's empty PG-major; the default mismatch precedes validation.
The class is inconsistent normalization across producer and consumer, not a
missing fixture, storage failure or validator defect. Existing proof checks
correctly reject a different identity. The broad fix is to use the fleet's
existing unset-or-empty default at the producer, rather than add a fallback GET
or weaken equality. At10k agents the change is one constant-time env lookup;
GET count, memory, ownership and downstream guest restore are unchanged.

Archive searches were `campaign seed proof does not own this fixture controller
PG major` and `nested canary inherited seed proof empty default campaign
preflight`. The sealed-cohort GET case and the Docker PG-major selection case
are relatives; their first bad boundaries differ. This is a new normalization
incident, not proof that either earlier performance outcome recurred.

## Solution

Use `os.environ.get("CLOUDBENCH_GUEST_PG_MAJOR") or "15"` in `fixture()`, matching
the fleet's existing Bash fallback. Explicit nonempty majors retain their exact
value. Do not trim values the fleet does not trim. The existing full fixture
comparison still includes the cache token; no new public CLI argument, identity
waiver or fleet mutation is needed.

The identical owning command passed after this one-line private fix (exit0,
5.723s): `agents/venv/bin/python -m pytest -q
agents/benchmarks/cloudbench_campaign_inventory_test.py -k
normalizes_guest_pg_default_before_consume`. It uses the real complete GET
client against a loopback store, actual owner births/parent lock, the actual
fleet default stanza and the existing token producer. Unset, empty,15 and16
all consume the matching proof; exactly four complete GETs occur. All previous
module ASTs are unchanged, and the added test is selected by the existing
`campaign_inventory` compact gate in `scripts/tests/benchmark-live-results.test.py`.
Post-run formatting is AST-identical to the executed control; no new Ruff
violations were introduced. The original control process was reaped and its
captured native birth is absent. Private RED/GREEN commands and hashes remain
in the source packet. Integration and the normal composed deploy remain pending,
so status is open. No actual task success, fleet speed or native release is
claimed from these host-preflight controls.

## Human feedback

None recorded specifically for this normalization defect. The current user
requires proportional existing quick controls and an independent LIVE control
without interference; the private repair did not modify or steer that run.

## Reusable lesson

Apply the same unset-or-empty normalization before sealing prerequisite identity and before consuming it.
