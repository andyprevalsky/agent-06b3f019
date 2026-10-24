---
id: 2026-10-24-campaign-inventory-fixtures-missed-native-infra-stop-contract
date: 2026-10-24
title: K11 native infra stop broke 10 campaign-inventory fixtures (missing coordinator copy, 2-job retry stop, own-verdict assertion)
surface: infra
component: cloudbench-campaign-inventory-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: commit a25cf417a (K11) changed run-bench-campaign.py's contract — it loads its sibling cloudbench-shard-coordinator.py, stops at 20*infra >= scheduled_total, and keeps an exited attempt's own verdict while release is unverified — without updating agents/benchmarks/cloudbench_campaign_inventory_test.py fixtures
symptoms:
  - "FileNotFoundError: [Errno 2] No such file or directory: '.../workspace/scripts/cloudbench-shard-coordinator.py'"
  - "AssertionError: blocked owning GET did not start"
  - "assert 1 == 2 where 1 = len([{'task': 'broken', 'attempt': 1, 'event': 'started'}])"
  - "AssertionError: current attempt inherited prior task_status"
tags:
  - cloudbench
  - campaign
  - infra-stop
  - test-fixture
sources:
  - commit a25cf417a (first bad; 16/16 pass at its parent)
  - commit aa7ff0dfa (fixture alignment, branch fix/campaign-inventory-red)
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py -k "retries_only_released_infra_without_restarting_peers or seed_preflight_campaign_cancellation_drains_get or seed_preflight_full_get_once_for_exact_50 or seed_preflight_failed_proof_publication"
status: fixed
---

## Problem

Ten `cloudbench_campaign_inventory_test.py` cases failed deterministically on
feat/rose-user-ui (929eaec70, 9b34cd740). They failed alone in about 2s, so
they were neither concurrent-load flakes nor memory-watchdog kills (the only
kills in the run window were unrelated `node` processes). The ten cases were 6
`retries_only_released_infra_without_restarting_peers` parametrizations
(infra, infra-strict, infra-parent-owned, exhausted, retry-unverified,
retry-handle-missing) and 4 seed-preflight cases.

## Diagnosis

Bisect: all 16 selected cases pass at a25cf417a^, and the same 10 fail at
a25cf417a and at 9b34cd740. a25cf417a is not on origin/main. Three independent
fixture/contract mismatches:

1. Seed preflight (4 cases): `infra_stop_predicate()` runpy-loads
   `scripts/cloudbench-shard-coordinator.py` beside the campaign. `seed_fixture`
   copies an explicit script list into a temp workspace that lacked it, so the
   campaign died with FileNotFoundError before its GET.
2. Retry mechanics (5 cases): the fixture schedules 2 jobs and makes one an
   INFRA failure. 20*1 >= 2 meets the fixed-total stop, which correctly cancels
   before the retry the test asserts.
3. retry-unverified (also hit by 2): K11 keeps an exited attempt's own
   recorded verdict when release is unverified. The test asserted
   `task_status/infra_failure/terminal_task` were None, conflating "not
   inherited from attempt 1" with "no verdict".

Production campaigns run from the repo checkout, where the coordinator exists,
so no runtime path was broken.

## Solution

Test-only (aa7ff0dfa):
- Copy the coordinator into the seed fixture workspace.
- Run the retry-mechanics case with the documented operator opt-out
  `CLOUDBENCH_ORIGINAL600_INFRA_EARLY_STOP=disabled`. The stop keeps its own
  campaign-hub-grouping regression.
- Assert the current attempt carries its own verdict (PASSED, not attempt 1's
  INFRA_ERROR) while release fields stay None.

No runtime change, so there is no 10k-agent impact.

## Human feedback

Parent required treating pre-existing failures as /deploy blockers (CLAUDE.md rule 16), separating real failures from load/OOM, bisecting, and no assertion weakening.

## Reusable lesson

When a controller gains a sibling-module dependency or a new stop/verdict contract, update every fixture that snapshots its script list or encodes the old contract in the same change.
