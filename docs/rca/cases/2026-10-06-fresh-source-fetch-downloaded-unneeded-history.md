---
id: 2026-10-06-fresh-source-fetch-downloaded-unneeded-history
date: 2026-10-06
title: Fresh REAL source bootstrap downloaded unused benchmark repository history
surface: infra
component: cloudbench-exact-source-bootstrap
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: an explicitly fresh checkout with no HEAD fetched every reachable earlier source version despite requiring one exact source tree
symptoms:
  - "[cloudbench] git-fetch 197s"
  - "[cloudbench] git-fetch 260s"
  - "[cloudbench] git-checkout 68s"
  - "worker did not reach queue readiness within 300s"
tags:
  - cloudbench
  - exact-source
  - fresh-volume
  - git-history
  - startup
  - autoscaled-worker
  - history-ledger
  - test-mass-agent-run-0
sources:
  - commit c214f5199646cb3bb51a81ef243df8ee01991536
  - fleet run 20261006-205802-14851
  - fleet run 20261006-205741-10814
  - benchmark run original600-1792722242636117810 (descend-full69-20261023)
  - fleet run 20261023-024011-28210
  - fleet run 20261023-024011-28265
  - task test-mass-agent-run-0
repro: bash scripts/tests/cloudbench-fetch-ref.test.sh
status: open
---

## Problem

The two ordinary task-free canary guests on c214 completed genuine source fetches
in 166 and 197 seconds, followed by 27-second checkouts. Maintenance took zero
seconds, and the later immutable driver's exact-ref synchronization took zero
seconds because boot had already verified the checkout. Both infrastructure
probes passed and completed native release; these delays are not task failures.
The selected fifty-task execution continues independently on its original source.

The image contains source and dependencies under `/app`, but Docker ignores Git
history and some tracked reference/media paths. Fresh REAL volumes have no HEAD.
A warm-source snapshot refresh cannot reach this ordinary path, and image files
alone cannot certify exhaustive tracked-source equivalence. Restoring donor
storage would reintroduce the previous snapshot-readiness prerequisite.

## Diagnosis

The owning fetch helper initializes absent/empty storage only after the explicit
fresh-volume handoff. Its no-HEAD branch then ran the same unbounded-history fetch
as a retained repository. Source startup reads the requested HEAD and tracked
files, applies the checksum-pinned workspace patch, and verifies dependency
manifests and Prisma readiness. Controller-side fetchable-ref selection retains
its full Git repository; its merge-base calls are not guest startup readers.
No current guest startup or DAILY evaluator reader requires earlier versions of
the benchmark repository. The task's external repositories are separate state.

The registered real-Git fetch test verifies exact SHA, Git tree and tracked bytes,
then requires that an earlier unused blob was not transferred to fresh storage.
Unchanged c214 fails that assertion in 2.344 seconds; the same control passes in
2.721 seconds with the candidate. The actual extracted primary and worker startup
callers also fail four cases before the change and pass all four afterward,
including unchanged dependency/Prisma failure inverses. Final frozen-source
qualification and reuse evidence are preserved in the review packet.

Archive searches were `git-fetch bootstrap-checkout snapshot source stale prefetch`
and `source fanout warm dependency snapshot Git negotiation`. Related cases are
`2026-10-06-real-image-clones-waited-for-unneeded-donor-snapshot`,
`2026-10-05-snapshot-proof-owned-by-controller-checkout`, and
`2026-09-11-exact-ref-fast-path-retained-patched-worktree`. This is a distinct
source-history boundary, not a recurrence of provider RESTORING or dirty-base
patch replay.

The local c214 current tree contains 8,686 blobs and 1,904,989,394 uncompressed
bytes; reachable history has 39,973 blobs and 23,817,187,431 uncompressed bytes.
Those are object inventory totals, not network transfer measurements or predicted
seconds saved. The shared 1.12 GiB pack store also includes unrelated refs.

Golden references: Claude Code `src/utils/plugins/pluginLoader.ts:578` fetches
an exact SHA at depth one; OpenClaw `test/scripts/ci-linux-git.test.ts:393` scopes
QA source bootstrap to depth one; Hermes `hermes_cli/profile_distribution.py:236`
shallow-clones a source distribution. Hermes `hermes_cli/worktree_ops.py:397`
separately deepens history when ownership cleanup actually needs it, and
OpenClaw `scripts/install.sh:3348` preserves commit history for a persistent
self-updating install. Their common pattern is to choose history from the
consumer's contract. No applicable Codex checkout was available locally.

## Solution

Add `--depth=1` only when the explicit fresh handoff has no verified HEAD. The
existing retained path keeps its HEAD negotiation hint and available history.
The requested source tree is complete; this is not a lazy private partial clone,
and no credential is persisted for later historical reads. Authenticated origin,
request-scoped token cleanup, fetch/HEAD verification, patch handling, dependency
proof, worker readiness, ownership and task limits remain unchanged.

The existing compact shell deploy gate owns the fresh-transfer and full-history
retained inverse. Two additional cases in the existing controller family advance
a formerly fresh checkout through the normal retained fetch branch, clear an old
workspace patch, verify new HEAD/tree/bytes and available parent history, apply a
new canonical patch, and invoke the actual dependency synchronizer. Matching
manifests pass; a changed Python manifest refuses the old donor without changing
its installed fingerprints. Their name matches the existing compact
`fetch_ref_restores_dirty_exact_sha` selector. The full controller module remains
registered by `scripts/test.sh`; no separate test framework was added.

A changed injected fetch helper changes the source-review recipe fingerprint.
Healthy ordinary launch does not consult the pre-service recovery approval
policy. Exact pre-service recovery still requires the existing independent source
review and committed recipe approval workflow, with the same existing phases.
Do not manufacture a new phase, skip a source check, or append an unreviewed hash
to make a control green. The review packet binds the changed fetch helper and
unchanged remaining recipe inputs before that compatibility update.

Private evidence and frozen candidate are under
`.context/independent-daily50-control-20261006/source-prefetch-c214.private/` in
the owner workspace. No provider or model request, live source edit or live task
mutation was made. The local qualification establishes reduced historical object
scope, not a fleet-speed improvement. A future uncached ordinary CLI run must
measure build, activation, startup, execution, evidence and full native release
before a total E2E benefit is claimed. This case remains open pending that run.

Root's independent source/phase review verified all 39 source inputs: 38
unchanged, with only the injected fetch helper modified. The exact new recipe
`2f474af2d5fca3b6dda86cc1851b734e90882ce67f12ab85c39e09273fd6dc03` is
registered in the committed existing policy for only the previously reviewed
`before-stack-launch` and `agent-network-index-bootstrap` phases. All old entries
remain. On that committed source, the unchanged normal bootstrap recovery gate
passes 25 controls in 47.908 seconds and pre-service recovery passes 13 controls
in 0.791 seconds. The final affected source/auth/reuse controls pass 26 cases in
12.629 seconds. No new phase or generic validator bypass was introduced.

## Recurrence 2026-10-23 (descend-full69-20261023, cluster K5)

Member: `test-mass-agent-run-0`, both copies (r001-j0004, r002-j0039), FAILED
`Timeout after 918s` / `907s` with root ACTIVE and 51 tree agents. Every
autoscaled performance-1x worker clone (`mode=fresh` in `worker-clones.log`, so
the 2026-10-06 `--depth=1` branch DID run) logged `[cloudbench] git-fetch
224-273s` plus `git-checkout 68s` for cbbf3dd0c and was removed after
`did not reach queue readiness within 300s`; the tree ran on the primary alone.
The triage hypothesis of a stale Oct-13 Git HEAD fetching intermediate history
was wrong for this run: the clones had no HEAD.

Why the earlier guardrail did not hold: it bounded commit *history*, not the
size of the one requested *tree*. That tree grew from 1.905 GB (1.433 GB of
`agents/benchmarks/history/*.jsonl`) at c214 to 3.221 GB at cbbf3dd0c, of
which 2.706 GB is 150 history ledgers. Wire bytes stay small (a full depth-1
pack is 331 MB locally) but upload-pack, index-pack inflation and checkout
still process 3.2 GB. Autoscaled workers never read those ledgers: agent
runtime code outside `agents/benchmarks`/tests/scripts imports no benchmark
module, the primary's runner owns ledger reads/appends, and
`scripts/create-worktree-patch.sh` already excludes them from the patch.

Local measurement on this devbox (file:// transport, both sides local): the
unchanged fresh depth-1 fetch of cbbf3dd0c took 125s before any checkout; the
fixed helper completed fetch 1s + checkout 22s (826 MB worktree), verified HEAD.

Fix: `cloudbench-worker.sh` requests `CLOUDBENCH_SOURCE_SCOPE=worker-runtime`.
Only on the explicit fresh no-HEAD branch, `cloudbench-fetch-ref.sh` sets a
non-cone sparse definition omitting exactly `agents/benchmarks/history/*.jsonl`
and adds `--filter=blob:none`; checkout fetches the remaining blobs once under
the request-scoped credential. After checkout it fails closed if any other path
is skip-worktree. Unknown scopes fail closed. Primary/retained paths, the
readiness gate (300s), task timeouts and patch/dependency verification are
unchanged. If a server ignored the filter, git falls back to the full depth-1
transfer (correct but slow), visible in the `git-fetch` timing line.

Repro: `bash scripts/tests/cloudbench-fetch-ref.test.sh` (deploy structural gate
`cloudbench-fetch-ref`, `scripts/test.sh` "Cloud Benchmark Git Fetch"). On
b84475d38 it fails `FAIL: fresh worker checkout wrote an unused benchmark
history ledger`; with the fix it passes 5/5. Outcome: not reproducible locally
(autoscaled Fly workers do not exist in `--local`); outcome proof is the
parent's cloud rerun `scripts/run-bench test-mass-agent-run-0` (5 passing runs).
Archive searches: `git-fetch git-checkout worker queue readiness 300s fresh
volume depth`, `benchmark history ledger size checkout tree growth
span_durations jsonl`, `grep -rl "did not reach queue readiness"`.
Recurrence of this case (same boundary class: fresh exact-source bootstrap
transfers content its consumer never reads). The separate `unable to start
machine from current state: 'created'` clone-start failures were contributing
and are not addressed here.

## Human feedback

The user requested parallel diagnostics and supported startup improvements.
Root required actual unchanged owning RED/GREEN, exact SHA/source/auth and
independent donor/dependency proof, no in-flight changes or paid requests, no
1.36 GB Gitseed copy, explicit fresh-checkout history tradeoffs, and normal reuse
and recovery qualification. Existing task/model/evaluator semantics remain.

## Reusable lesson

Fetch only the history and tree paths an ephemeral exact-source consumer reads while preserving the source and dependency contracts and existing retained-history readers.
