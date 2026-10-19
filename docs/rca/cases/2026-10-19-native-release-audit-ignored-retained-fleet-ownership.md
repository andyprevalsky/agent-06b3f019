---
id: 2026-10-19-native-release-audit-ignored-retained-fleet-ownership
date: 2026-10-19
title: Sharded native release audit certified release while three retained fleet guests were still started
surface: infra
component: cloudbench-native-release-audit
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-native-release-audit.py owned_from_archive (and the duplicate OWNED_PATTERN in scripts/cloudbench-scorecard.py export_records) read only run-local teardown-ownership owned-clones and worker-clones.ids, never a retained fleet's primary.ids or its exported git-common ownership registry/audit
symptoms:
  - native-release-audit.json released true present []
  - no current run artifact produced
  - guest cleanup was not acknowledged; machine ownership must be retained (HTTP 202)
  - timed-out guest shutdown unconfirmed; retaining runtime evidence owner -- infrastructure failure
  - CONTROLLER_RELEASE_VERIFIED while task guests still started
tags:
  - cloudbench
  - sharded-campaign
  - native-release-audit
  - leaked-machines
  - fleet-ownership
  - fail-closed
sources:
  - fleet run original600-1792440129763435696
  - fleet run 20261019-201626-26147
  - fleet run 20261019-201626-26089
  - fleet run 20261019-201740-25270
repro: scripts/tests/cloudbench-scorecard.test.py NativeReleaseAuditOwnership
status: fixed
---

## Problem

The fresh-agent rerun of 70 random polar tasks (`--timeout 300`, main
6d3b7c4da, admission `original600-1792440129763435696`, three disposable
controllers) finished with `observed_jobs 70`, `resources_released 67` and
three UNKNOWN jobs ("no current run artifact produced"). All three controller
`terminal.json` receipts said `CONTROLLER_RELEASE_VERIFIED`, and the operator's
`native-release-audit.json` said `released: true, present: []` after checking
73 recorded guest IDs. A native Fly listing an hour later still showed three
started task guests with their 40 GB volumes:

- 8ed954ef9d2138 / vol_4m3mqdlj75d6901v, owner dc1f0309…, task polar-odysseys-a24232e8f6e7 (shard-02)
- 820120f7764438 / vol_re1wxlm8mj20ww14, owner 5117f2f2…, task polar-odysseys-753ce2163f6e (shard-02)
- e82037df15e468 / vol_r7ymxn76780g71gr, owner daffda62…, task polar-odysseys-d3250da48cc7 (shard-01)

None of the three IDs appeared in the audit's `checked.guest_ids`.

## Diagnosis

Critical path: guest driver → per-task `run-bench-cloud` → `run-bench-fleet`
ownership registry and audit (controller `.git`) → controller export
`originals.tar.gz` → disposable controller cleanup → operator
`native_release_audit` → scorecard.

1. Each task's agent hit its 300 s backstop and its outcome was ACKed. The
   driver's post-outcome finalization was then interrupted by the 300 s Polar
   semantic-inactivity watchdog: `Benchmark interrupt cleanup status:
   state=failed`, then `FATAL: benchmark root cleanup was not confirmed; refusing
   guest cleanup acknowledgement` in the guest `bench.log`. The fleet therefore
   logged `guest cleanup was not acknowledged; machine ownership must be
   retained (HTTP 202)` and kept its registry with `cleanup_policy=retain`,
   `guest-cleanup-unconfirmed` and `runtime-evidence-unconfirmed`. Its audit
   `meta` stayed `status=incomplete`, and `_batch/lifecycle.json` was
   `status: failed` with an empty `audit_sha256`. Why the driver was interrupted
   is a separate cause (see the polar finalize case); retaining was correct
   fail-closed behavior.
2. A retained fleet never moves its audit into the run directory. The run dir
   has only `teardown-ownership.path` pointing at
   `.git/cloudbench-fleet-audits/<token>`. The primary ID is in
   `<run>/<bench>/primary.ids` and in
   `.git/cloudbench-fleet-ownership/<token>/clones/<name>` (`name`, `id`,
   `volume_id`). The controller export captured all of it under `git-common/`
   and `context/fleet/runs/`. In the shard-02 export, exactly the two leaked
   tokens still have ownership registries and `incomplete` audits; the other
   22 audits are `provider-teardown-verified`.
3. **First bad boundary:** `cloudbench-native-release-audit.py` builds its
   owned set only from `context/fleet/runs/*/teardown-ownership/owned-clones.*`
   and `*/worker-clones.ids`. The operator passed in the identical set from the
   scorecard's duplicate `OWNED_PATTERN`. Neither reads `primary.ids`, the
   git-common registries or the audits. Retained guests are therefore exactly
   the ones never checked, and an empty `present` list was reported as
   `released: true`.
4. Deepest owned cause (Step 5a): the release proof was keyed to "identities
   that a successful teardown recorded", not to "every owner this run
   created". The failure the audit exists to catch (an owner that did not
   finish teardown) was structurally invisible to it. The same blind spot hid
   the ownership-handoff gap: the disposable controller cleanup deleted each
   controller (and with it the only host that can run
   `run-bench --recover-stale-owner`, which requires the same host) after a
   verified export. No step discharged or surfaced the exported retained
   owners.

Reproduction: `python3 scripts/tests/cloudbench-scorecard.test.py
NativeReleaseAuditOwnership` builds a one-shard admission whose export holds
one released fleet and one retained fleet shaped like the real export (real
IDs/names/tokens). On origin/main it failed with `AssertionError: True is not
false : a live retained guest never certifies release`.

## Solution

`cloudbench-native-release-audit.py` is now the single owner of exported
ownership extraction (the scorecard's duplicate regex was deleted, and the
operator no longer passes pre-extracted identities). It reads:

- run-local teardown owned-clones, plus `primary.ids` and `worker-clones.ids`;
- every exported `git-common/cloudbench-fleet-ownership/<token>` registry
  (clone name, Machine ID and volume ID);
- every `cloudbench-fleet-audits/<token>` audit (owned-clones).

It lists Machines and Volumes once each. A Machine counts as present when its
ID, name or exported owner token (the `CLOUDBENCH_RUN_TOKEN` prefix; no env
value is recorded) matches. A Volume counts as present when its ID, its
attachment to a present guest or its `cbv_` name matches and it is not
destroying. The audit fails closed while any exported ownership registry
remains (`retained_owners`), even when nothing is natively present. Only
exact-owner recovery retires a registry. The scorecard renders present guests,
present volumes and retained owners as a red "Guests released (native audit)"
row.

Replaying the new audit on the real admission's exports against the live
listing (after the manual release) reported `retained_owners` = exactly the
three leaked tokens, all three IDs in `checked.guest_ids`, and `released:
false`.

10k-agent behavior: one Machines list and one Volumes list per admission audit
(O(app Machines + Volumes)), one pass over each shard archive, and no per-agent
calls. Owner-token matching is exact on 32-hex tokens, so other campaigns and
warm donors are never matched.

Adversarial review found that the first candidate counted verified exports per
attempt, not per shard. With a retried shard, an earlier attempt's export could
satisfy `exports == shards` while the final attempt had none, which fails open.
`test_retried_shard_counts_only_its_final_attempt_export` failed on that
candidate (`verified_exports` 2 instead of 1). It passes now that the count
uses each shard's final `coordination.json` `out`. Ownership is still read from
every attempt's export.

Known limits:

- An admission whose exported owner was released outside exact-owner recovery
  (as here) stays `released: false` permanently. That is an evidence gap, not
  a live leak. Read `present`/`present_volumes` for the native state.
- Fresh clones transferred to a pool keep their fleet token and are reported
  present.
- Token matching against live leaked guests was proven on the fixture. The
  real replay ran after the manual release and exercised only the
  retained-owner path.

The leak's own cause (why each fleet ended with `guest-cleanup-unconfirmed`,
and why no run artifact was produced) is a separate open RCA. It is not closed
by this fix, which only makes the leak visible.

Not fixed here (open): retained owners are still exported and the controller
is deleted without discharge. `cloudbench-archived-owner-stop.py` (stop-only)
exists but is not invoked automatically. The three guests were released
manually from the export records. Separately, the fleet's post-retention
`guest-shutdown.confirmed` reader raises a raw `FileNotFoundError` instead of
reporting absence.

## Human feedback

The parent instruction required the audit to enumerate by the run's ownership
markers (owner tokens and name prefixes), not only by recorded IDs, and to
fail closed. Clone names have no run-specific prefix (`cloudbench-<random>`),
so matching uses exact exported names plus owner tokens.

## Reusable lesson

Derive a release audit's ownership set from every owner the run created (registries, audits, primaries, native owner tokens), and fail closed on any owner that never retired, never only from identities a successful teardown wrote.
