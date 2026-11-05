---
id: 2026-11-02-staged-checkout-omitted-private-temporal-config
date: 2026-11-02
title: Staged worker preparation omitted the private benchmark Temporal configuration
surface: infra
component: staged-deploy-worker-preparation
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/deploy_test_worker.py prepare_checkout(copy_config=True) excludes agents/.env.benchmark-temporal from its private configuration copy list
symptoms:
  - This stack would run in the production Temporal namespace rose-labs-us-east-1.tch2n
  - run.sh exited early with code 1
  - cleanup receipt is missing or unsafe
  - agentcard-lifecycle returned UNVERIFIED before any lifecycle task started
tags:
  - temporal
  - private-config
  - staged-deploy
  - checkout-preparation
  - cleanup-evidence
sources:
  - PR #1662
  - commit e99c91f55b9444f01a90bd4e8efc18315faeb51b
  - commit 6f3f53201faac3a3e70de099e7c211cee6770fad
  - task 284cd8353f7249a48ee6f8a28ec3894a
  - benchmark run 1793650760-1731177-44930
repro: scripts/tests/deploy-test-worker.test.py Worker.test_copy_config_preserves_benchmark_temporal_routing (draft executed in private fixture)
status: open
---

## Problem

The final AgentCard lifecycle gate for frozen source
`e99c91f55b9444f01a90bd4e8efc18315faeb51b`, source digest
`2417622cb6e59d08562b56db51a3a8ce7e9b5effc0783dbbb41f63c980bc019e`,
returned native `UNVERIFIED`, exit 1, complete=false. The stack failed before
the four requested payment lifecycle tasks started. It did not produce task
outcome proof.

The occurrence is
`/var/tmp/staged-deploy-implementation/.context/deploy-pipeline/rca/284cd8353f7249a48ee6f8a28ec3894a.json`.
Its worker log SHA256 is
`cce48f8d96a5d0d5ad92e57b3f34957a466a8c1a31284f7881114cc741878ec0`;
the investigator checked it against the preserved original file. The first
failure in
`/var/tmp/pr1662-worker-seed-cache-decision/.context/benchmarks/1793650760-1731177-44930/services.log`
is the production-namespace refusal. `local-benchmark-owner.json` records
state `not_started`.

The canonical private benchmark configuration existed at mode 0600, but both
the staged source and its isolated worker lacked it. No secret values were
printed. Original evidence copies and hashes are in
`/var/tmp/pr1662-agentcard-rca-284cd835-ez_gyepc/native-manifest.json`.

## Diagnosis

**Gate: INTRODUCED.** Compared baseline main
`6f3f53201faac3a3e70de099e7c211cee6770fad` with candidate
`e99c91f55b9444f01a90bd4e8efc18315faeb51b`.

The path is: private canonical configuration -> staged source preparation ->
`prepare_checkout(copy_config=True)` -> isolated worker -> `run.sh` ->
`stack_bench_temporal_exports` -> fail-closed namespace refusal -> benchmark
runner sees startup exit and cannot validate cleanup.

The candidate adds `scripts/deploy_test_worker.py`; main has no such file.
The helper's explicit copy list includes the standard env files but excludes
`agents/.env.benchmark-temporal`. Its receipt can report
`configuration_copied=true` while discarding the input that makes the
source's Temporal routing usable. The guard, `scripts/run.sh`,
`agents/temporal_connection.py`, and `agents/benchmarks/local.py` are unchanged
between the compared revisions. `scripts/lib/cloudbench-env.sh` has SHA256
`332f0695488e5ed312506b822bb658b3de4e9c261df7263e0fbc8ef01874eb03`
on both revisions. Both routers fail without the sidecar and pass with it.
The production guard is working; disabling it would conceal the setup defect.

The deploy owner confirmed in thread `ph7be5xenv5an7pk90zhhzae4n8h50sb` that
the original worker was prepared with the versioned `--prepare-checkout
--copy-config` path from staged source, whose own initial provisioning copied
only standard env files. No standalone original invocation receipt was
found. That provenance limitation is retained; the mechanism was independently
reproduced using the actual helper. The available preparation records
`local-agentcard.json` and `local-agentcard-source.json` are preserved with
the native evidence.

### Executed causal proof

All following artifacts live under
`/var/tmp/pr1662-agentcard-rca-284cd835-ez_gyepc/`. They use tiny local Git
fixtures, synthetic credentials, the actual preparation helper, and the real
namespace selector. They start no service and make no provider calls.

The exact preparation regression command was unchanged before and after:

`/usr/bin/python3 /var/tmp/pr1662-agentcard-rca-284cd835-ez_gyepc/run_drafted_regression.py`

- Before: exit 1 in 0.39911723136901855 seconds. The source routes successfully;
  the prepared worker fails `self.assertEqual(0, result.returncode, result.stderr)`
  with `0 != 1` and the original production-namespace refusal.
- After the temporary copy-list correction: exit 0 in 0.43584632873535156
  seconds. The same test verifies nonproduction routing, byte preservation,
  unchanged source owner/mode, and a destination owned by the current user
  at mode 0600.

The fingerprint regression command was likewise unchanged:

`/usr/bin/python3 /var/tmp/pr1662-agentcard-rca-284cd835-ez_gyepc/run_drafted_cohort.py`

- Before: exit 1 in 0.3416717052459717 seconds; rotating the ignored sidecar's
  synthetic API key leaves a ready receipt incorrectly valid (`5 != 0`).
- After including the sidecar in runtime fingerprints: exit 0 in
  0.25396084785461426 seconds. Credential changes and deletion invalidate the
  receipt while the source digest remains unchanged.

Exact results and log paths are in `final-before-after.json`. The six-test
focused cohort passed five consecutive times in `final-cohort-results.json`.
The permanent target suites are already registered in
`scripts/run-deploy-structural-gates.py` as `deploy-test-worker` and
`deploy-test-cycle`. These are causal and regression proofs, not a substitute
for the full lifecycle gate.

### Why cleanup evidence is absent

On the frozen source, `run.sh:500-501` exits immediately when the Temporal
selector refuses the configuration. The service cleanup EXIT trap is installed
only at `run.sh:2764`, so this early branch never calls `cleanup()` or its
`run_publish_stack_cleanup_status` calls. The retained run directory has no
cleanup receipt or services manifest. This explains the downstream missing
receipt without proving resource cleanup.

The supported command was executed from the original isolated worker:

`bash scripts/run-bench --local --run-id 1793650760-1731177-44930 --reconcile-cleanup`

It returned exit 1: `cleanup receipt is missing or unsafe` for the original
`local-stack-cleanup.status`. The reconciler requires an existing pending
receipt and refused to invent one. Exact command, timestamps, and output are
preserved in `cleanup-reconcile.json` and `cleanup-reconcile.log`. No receipt
was fabricated, no unrelated process was stopped, and cleanup remains
unverified. A new successful run cannot retroactively certify this run.

Archive searches used `This stack would run in the production Temporal
namespace` and `isolated clone missing benchmark Temporal environment`.
This is a relative of
`2026-10-27-dev-bench-stacks-shared-prod-temporal-namespace-and-pooler`, not a
recurrence of its failed guard: the existing protection correctly rejected
the newly incomplete clone.

## Solution

Draft only: include `agents/.env.benchmark-temporal` in the existing private
copy list and runtime-config fingerprint list. Keep the existing 0600 copy
behavior and production-namespace rejection. Add the two regressions above
to the existing registered suites. The complete four-file patch is
`/var/tmp/pr1662-agentcard-rca-284cd835-ez_gyepc/complete-fix.patch`, SHA256
`90b83bb6781316f68e14bac201cdac89ffa2d9634caa405517293ed1c990b672`.

This unifies the required configuration with the existing copy/fingerprint
contracts rather than adding a bypass. Its cost is one small file copy per
checkout and one file hash per fingerprint collection, with no per-agent
runtime work. Golden reference: not applicable (no approval-gated hunk).

With the deploy owner's explicit scope instruction, the existing canonical
private file was copied only to the isolated worker at 0600 and verified
byte-equal; its native selector then returned 0 with a complete nonproduction
configuration. Receipts are `config-copy.json` and
`worker-routing-after.json`. The active coordinator was not changed.

Application source, parent documentation, and benchmark assertions were not
edited. No full gate or new deployment was launched. The patch is unintegrated,
the exact four-task lifecycle outcome remains UNVERIFIED, and the original
cleanup evidence gap remains open. This case must not be marked fixed until
the parent integrates the repair, runs the registered validation, and records
the unchanged lifecycle gate's actual result. There is no provider outage or
credit evidence and no external-provider exception.

## Human feedback

The user restricted this investigation to evidence, private narrow reproductions,
and an exact draft fix; the parent retains source and deployment ownership.
The user prohibited altered assertions or budgets, unknown-result waivers,
and interference with Freedom. The deploy owner requested private 0600
provisioning of the existing worker config, runtime fingerprint coverage,
and a private schema-valid case draft, with no parent-document edits or new
tests beyond the already prepared focused regressions. All remain in force.

## Reusable lesson

Preserve and fingerprint every private configuration input required by a prepared worker, while retaining fail-closed service guards and honest cleanup evidence.
