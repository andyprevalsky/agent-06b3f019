---
id: 2026-10-05-snapshot-proof-owned-by-controller-checkout
date: 2026-10-05
title: Fresh controllers rebuilt reusable dependency snapshots because proof existed only in the local Git directory
surface: infra
component: cloudbench-warm-dependency-cache
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet snapshot selection and warm_deps_preflight read only controller-local cloudbench-warm-deps.fp
symptoms:
  - warm snapshot dep trees unproven/stale
  - healing warm snapshot (dep trees)
  - fresh checkout unnecessarily rebuilt and snapshotted reusable dependencies
  - snapshot epoch exact snapshot absent
  - warm snapshot freshness could not be verified; refusing maintenance
tags:
  - cloudbench
  - dependencies
  - snapshot
  - cache-ownership
  - startup
sources:
  - commit 813bdbfe28077fe904e960b614be686083dce846
  - fleet run 20261005-091438-84183
  - commit 7b89e7902998fd49773a5b4273acd9e9678f22e1
  - fleet run 20261027-211452-477248
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fresh_controller_reuses_only_proven_donor_dependencies
status: open
---

## Problem

The ordinary fifty-task CLI run performed central dependency maintenance and
waited roughly fifteen minutes for its newly created snapshot. The provider
inventory saved before launch had no dependency-cache metadata on the stopped
donor. The initial local receipt was overwritten by maintenance, so the exact
reason that this run selected maintenance cannot be attributed solely to missing
local state; genuinely changed dependencies remain another possible trigger.

The owning preflight reproduction isolates the fresh-controller defect: a
completed donor snapshot with matching dependency fingerprints is available,
but no local Git receipt exists. The original preflight unnecessarily rebuilds
it. Original maintenance also never publishes reusable proof to the donor.
The private red artifact records four failures and nine passing controls; the
same preflight and maintenance cases subsequently pass without weakening the
cache-reuse assertion. No raw cloud logs or credentials are checked in.

## Diagnosis

Path: completed provider snapshot and its dependency hashes → local Git receipt
lookup → warm preflight → central install and new snapshot. The controller
treated a local cache receipt as the only evidence for a remote artifact whose
lifetime exceeds that checkout. Sibling worktrees share the Git common directory;
fresh clones and controllers on other hosts do not. Moving only the local file
would retain the same ownership error.

Archive searches used `warm snapshot dep trees unproven stale` and
`fresh checkout dependency fingerprint snapshot repeated rebuild`. This is a
relative of the July 15 baked-donor mismatch and September 11 exact-workspace
maintenance cases, with a distinct first-bad boundary: discovery of existing
proof rather than dependency contents or patch application.

The failed fifty-task run subsequently encountered an outdated container image
without PostgreSQL vector support before either canary reached the barrier.
That outcome is separate from this cache defect. No benchmarks executed and no
benchmark success is inferred from these cache regressions.

## Solution

Publish dependency-specific metadata on the donor only after exact snapshot
completion and the existing source/fingerprint checks. The default fleet reads
the native donor and snapshot inventories before selecting its recorded snapshot
and atomically restores the local receipt when fingerprints, app, donor, volume,
creation epoch, and completed snapshot all match. Source-only changes continue
through the existing exact code synchronization path.

A verified legacy local receipt is published through the same default fast
path without reinstalling or snapshotting. Different dependency sets have
independent keys. Invalid or incomplete proof never authorizes reuse. Publication
uses the Machines metadata-only endpoint, so it never starts, stops, or updates
the donor runtime. Publication failure warns while preserving the already
verified local snapshot; it is not a new benchmark rejection gate.

The focused twenty-case group passes in 28.24 seconds. The real local
HTTP transport fixture asserts the metadata endpoint, payload, authentication
privacy, and failed publication. The new cases are selected by the benchmark
blackbox domain and `/deploy` Step 4cb; `scripts/test.sh` also runs the complete
existing controller module. At fleet scale, each controller performs its normal
shared inventory reads and one cache lookup rather than rebuilding per task.
No models, prompts, evaluators, task definitions, or normal deadlines changed.

The independent review also reproduced a pinned-snapshot control whose optional
legacy publication referenced an inventory that pinned selection never loads.
The unchanged control passes after skipping that optional publication when the
inventory is absent. The permanent blackbox wrapper now expects all 44 selected
cases, including this control, rather than its obsolete 33-case total. Independent
execution of that exact registered wrapper passed. The final complete controller
module passed 645 cases with three explicit skips in 334.99 seconds; existing
environment and mandatory-autoscaler shell gates also passed.

Completed-proof discovery is established across fresh clones and hosts.
An additional unchanged reproduction exposed a sibling worktree replacing the
legacy on-disk receipt after hydration. Each fleet now pins the verified receipt
in memory and uses it for both snapshot selection and preflight. The same owning
review subset went from two failures and six controls to eight passes; the
existing publisher test also verifies remote HTTP rejection before transport,
while explicit loopback HTTP remains available for its local fixture. Private
artifacts are `cli-cache-review-red.private.log` and
`cli-cache-review-green.private.log`. Independent execution of the registered
44-case wrapper passed in 32.08 seconds. The final full-module artifact is
`.context/benchmarks/cli-cache-final-suite.private.log`. The default/private-source
fixture imports the same current helpers; 71 unchanged controls passed after
updating that extraction and the snapshot-read source assertion.

Simultaneous cross-host dependency rebuild serialization is not established:
the existing maintenance lock remains local to the Git common directory.

Owning red/green command, run from `agents` with its venv active:

```sh
python -m pytest -q benchmarks/cloudbench_dependency_sync_test.py -k 'fresh_controller_reuses_only_proven_donor_dependencies or refresh_deps_applies_exact_workspace_before_rebuild'
```

Private artifacts: `.context/benchmarks/cli-cache-reuse-red.private.log` and
`cli-cache-reuse-green.private.log`. The independent pinned red/green control
uses `-k pinned_warm_deps_preflight_keeps_verified_snapshot_without_unlisted_inventory`;
its red artifact is `cli-cache-pinned-red.private.log` and the unchanged green
control is included in `cli-cache-reuse-focused.private.log`.

During the separate one-time native-image repair, the upload included 1.45 GB
of generated benchmark runs and 1.16 GB of dated span rollovers. The root Docker
ignore now excludes those two groups. Current span metrics and task selection /
duration ledgers remain included; complete historical span diagnostics remain
in the controller checkout. Independent review approved this narrow input change.
This reduces image upload work and does not establish the cause of the earlier
provider build cancellation or a successful fifty-task run.

API contract: https://docs.machines.dev/machines/Machines_upsert_metadata

## Recurrence — a redundant read invalidated already hydrated proof

The unchanged-dependency cached50 campaign on `271ca1cfaca0` restored donor
metadata proof in all fifty controllers. Every controller selected the same
exact recorded snapshot `vs_keyA4NwX50ZfKDR43l8X`; thirty-one then took the fast
path while nineteen entered central healing. Seventeen maintenance siblings
waited on the app-environment lock, with observed waits up to 330 seconds.
Private ordered evidence is under `.context/fresh-cli-validation-20261005/`.
The first two actual maintenance owners completed dependencies and stopped the
donor before failing at snapshot publication. Those failures and the separate
controller dotenv race remain separate from dependency installation and task
results; no successful fifty-task outcome is inferred.

Hydration already checks current node/Python hashes, app, donor, attached volume,
exact snapshot identity, positive completed status/size and creation epoch, and
pins its receipt in process memory. The later preflight repeated the snapshot
listing only to obtain that same epoch, suppressing all provider errors. With
the manifests frozen and the hydrated receipt retained, an uncertain second read
was the remaining boundary that could reject this established proof. Git revision
is not part of this dependency predicate. The runtime logs cannot distinguish
transport rejection, empty listing or malformed response because the read hid
its diagnostics; no specific provider cause is claimed.

The existing owning preflight harness now captures valid matching proof, then
makes subsequent provider reads fail, return an empty list or return malformed
JSON. Old source fails all three unchanged reuse assertions. The repaired epoch
helper accepts the already captured inventory only for the hydrated fast path,
retaining every existing manifest/snapshot/epoch comparison. Legacy and pinned
paths keep their live reads; a new negative control also requires live epoch
and exact-complete validation after a newly created refresh snapshot.

The private old-source reproduction failed three cases in 1.28 seconds. Those
same cases plus the post-refresh refusal and existing donor/volume/hash mismatch,
pending/expired, sibling-receipt, legacy and pinned controls passed fifteen cases
in 3.44 seconds. Compact selectors must include these new owning controls before
the next live campaign. At 10,000 controllers, this avoids one redundant provider
read per proven snapshot and prevents a failed read from creating an unnecessary
central rebuild queue. It changes no model, task, dependency recipe, authentication,
result boundary or normal deadline. Live resolution still requires the next
actual fifty-task validation.

## Human feedback

The user requested faster startup for future agents, suggested persisted code
and incremental synchronization, wanted to avoid idle compute spending, and
required the improvement to be hooked into the CLI. They require compact,
cemented regression coverage rather than a new massive verification scheme.

## Reusable lesson

Store verified cache provenance with the remote artifact owner and restore local receipts through the normal CLI before rebuilding it.

## Recurrence — legacy local proof still re-read selected snapshot epoch (2026-10-27)

Polar k2 iteration3 source `7b89e7902998fd49773a5b4273acd9e9678f22e1` stopped
before task allocation. Three first-bad controllers were r001-j0008/BU008
(fleet20261027-211452-477248), r002-j0019/BU004 (477307), and
r002-j0023/BU008 (477383). All logged donor `683e47df5094d8`, then
`using recorded proven snapshot: vs_a56XkOMV2e9hmLg8BppZ`, then
`snapshot epoch exact snapshot absent` and freshness refusal. Their owned
clone inventories are empty. Do not change the original infrastructure verdict
or count recovered admission as a task PASS.

The selected local receipt contains exact snapshot ID and dependency hashes,
with epoch1792995448. The selection branch at this source only emits that
message after finding the ID in the initial volume list with complete status,
positive size, and creation timestamp. None of the three logs contains either
message emitted by successful remote proof hydration. Thus, by the exact
source control flow, these copies entered the local-receipt epoch branch and
made a second list read. That read parsed as a list but lacked the selected ID.
This is a control-flow deduction from preserved logs, not recovered raw bytes.

The underlying native omission remains unknown: the controller did not save
snapshot-list raw responses, return codes, stderr, or which epoch input path
ran. A later operator native read reportedly saw the snapshot on
`vol_vwnym366kn7k8mmv` attached to the same donor, but its raw snapshot bytes
were not saved either. It does not prove transient concurrency, pagination,
or any particular provider cause. The saved later volume list only establishes
that observed donor/volume association at its own time.

The prior captured-inventory repair covered remote hydrated proof but retained
the redundant read when the valid dependency receipt came from the legacy local
slot. This is the remaining branch of the same observation-consistency defect.
The repair uses the already captured selected inventory for its epoch
regardless of receipt location. Exact snapshot ID, dependency fingerprints,
status/positive-size selection and epoch comparison remain unchanged. A pinned
path with no captured list still reads live; a newly created refresh snapshot
still receives both live epoch and completion verification. No global cache,
new retry, fabricated timestamp, relaxed age, task or provider mutation is added.

The registered regression uses the real extracted preflight/epoch functions
with a valid local receipt and no matching donor metadata. Its first list
contains the selected complete snapshot; its second read fails, is empty, or
malformed. Unchanged source fails all three cases in4.40s, including the exact
absent-ID error for the empty list. The same assertions pass against the
reviewed repair. Nineteen focused cases pass in2.51s, including existing hydrated,
pinned, wrong donor/volume/manifests, pending/expired and live post-refresh
controls. Evidence and exact patch are in `.context/polar-i13/`.

Opened grounding: the existing selection and hydrated preflight mechanism
above; Codex `14ff9c3a43ebf9bf543cf5f7c45cff2bfea2e512`,
`codex-rs/config/src/requirements_layers/stack.rs:104-118` resolves hostname
once per composition to keep every layer on the same observation. The proposed
inventory lifetime is similarly one selection/preflight transaction. OpenClaw
`76ddbf697fc263cc1bf89fe3f4d08d96ed4a43af`,
`src/infra/backup-archive-publication.ts:75-120,185+` refreshes identity for
mutating publication; corresponding Rose post-refresh live checks are retained.
These are observation-consistency analogs, not authority to loosen Fly identity.

Independent review by ph74rex3pescaywbxyjn3njr158h3pp9 returned GROUNDED
for patch SHA256 0b76a24eb2710a93737cc83a2ffc0324d83efcc2c1c180085e0f382ff7a8e847.
Additional snapshot/pin/private-source controls passed 168 cases in39.56s.
The exact applied source then passed the combined 187 cases in41.66s; Bash
syntax and the archive validator also passed. Runtime and test bytes were
compared with a fresh application of the reviewed patch to the frozen base.
The recurrence remains open pending the unchanged cohort outcome; the earlier
fixed status did not cover this local-receipt branch. No
paid benchmark, deployment or native resource mutation was performed. The next
parent-coordinated unchanged cohort must prove admission and actual outcomes;
these deterministic controls do not establish a task PASS.
