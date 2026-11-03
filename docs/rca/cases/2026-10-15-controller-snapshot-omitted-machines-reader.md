---
id: 2026-10-15-controller-snapshot-omitted-machines-reader
date: 2026-10-15
title: Immutable controller snapshot omitted the Machines reader used by recovery
surface: infra
component: cloudbench-controller-snapshot
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The controller snapshot copy list omitted cloudbench-campaign-machines.py although recovery and pool consumers imported it from that sealed snapshot
symptoms:
  - FileNotFoundError
  - cloudbench-campaign-machines.py missing from CLOUDBENCH_SCRIPT_SNAPSHOT
  - exact stale fleet ownership recovery failed
tags:
  - cloudbench
  - immutable-snapshot
  - recovery
  - dependency-packaging
sources:
  - commit 659e3d6964f7b88d14a20f66d2fc8f14251beaf9
  - commit e58633c5a25ff808e7c4f92d007d1cefeab24f3d
  - plan:.context/i42-snapshot-native-helper/component-review.safe.json
  - plan:.context/stress600-root/i43-snapshot-helper-root-review/review.safe.json
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py BootstrapRecoveryTest.test_normal_controller_snapshot_includes_exact_machines_reader
status: fixed
---

## Problem

The ordinary exact-owner recovery on the retained original controller exited 1
before its native Machines read. Its 574-byte original log reports
`FileNotFoundError` while `runpy.run_path` loads
`$CLOUDBENCH_SCRIPT_SNAPSHOT/cloudbench-campaign-machines.py`.
The original log SHA256 is
`186358ec560bb7638cf91180377361110840864a1d3e099b0c5638f4784ac546`.
The owner, runtime latch and original failed task were retained; this attempt
released no proven capacity. The organization Machine limit is a separate
verified blocker and did not cause this import failure.

## Diagnosis

Path: normal fleet entrypoint creates its private immutable script snapshot →
copies the declared runtime files → seals the actual copied file set → enters
the snapshot → exact-owner recovery invokes `fleet_preconfig_native_read` →
`runpy` opens a helper that was never copied.

The source snapshot at `659e3d69` copies neighboring campaign barrier, mutation
and seed helpers but omits the Machines reader. Three consumers use the same
missing staged path: pre-config native reads, pool source-image reads and pool
native reuse proof. The campaign publisher has a separate, already-correct
copy path. The first bad boundary is the fleet snapshot producer, before
authentication, HTTP, native identity comparison or full pre-config capture
verification. Local `eligible-preconfig` validation had already succeeded before
that native-read import. Falling back to mutable repository bytes would break the sealed
runtime contract rather than repair it.

The existing manifest enumerates the files that were actually copied. It can
correctly verify an incomplete payload; that verification does not prove that
all consumers' declared dependencies were included. Earlier function-level
coverage did not execute this import through the actual snapshot launcher.
The repair belongs to that launcher and its permanent integration control.
All three affected consumers are repaired by including their shared helper;
no new manifest or alternate runtime loader is needed.

Archive searches used `cloudbench-campaign-machines.py FileNotFoundError` and
`immutable staged snapshot recovery helper dependency missing`. The late
recovery driver-log case is a relative: it omitted an evidence artifact during
collection, whereas this defect omitted executable runtime input during
snapshot creation. Neither its collector fix nor the fresh workspace Prisma
dependency case covers this producer/import boundary.

Reference inspection found related packaging boundaries, not an exact Fly
snapshot analog. OpenClaw `scripts/stage-bundled-plugin-runtime.mts:389`
compares the complete staged runtime tree, including file bytes and names.
Hermes `hermes_cli/update_cmd_zip.py:185` stages the complete update before
swapping entries so individually valid files do not produce a mixed runtime.
Codex `sdk/python/scripts/update_sdk_artifacts.py:237` validates required runtime
layout entries after copying the package. Claude Code `src/tools.ts:131`
loads its bundled workflow module before exposing the workflow tool. Their
shared constraint is that runtime consumers receive the packaged artifacts
they require. Rose already has a sealed snapshot producer; fixing its payload
and testing the actual consumer preserves that boundary without adding a
parallel deployment mechanism.

## Solution

Commit `e58633c5a25ff808e7c4f92d007d1cefeab24f3d` adds the unchanged
`cloudbench-campaign-machines.py` to the existing copy list before manifest
creation. Its only production change is that dependency line. The permanent
owning test is in the existing bootstrap recovery suite:

```bash
python3 scripts/tests/cloudbench-bootstrap-recovery.test.py BootstrapRecoveryTest.test_normal_controller_snapshot_includes_exact_machines_reader
```

The test invokes the real entrypoint with recovery-only arguments and an
invalid owner token. At the existing entry-ready hook, it executes the exact
`runpy` import from the actual snapshot, checks source-byte equality and the
manifest's helper SHA, and runs the staged provenance verifier. It never calls
`fetch`. It then releases and joins the child, verifies the normal invalid-token
exit 2 before recovery/provider activity, and checks owned snapshot removal.
Thus the test cannot substitute a source-tree import for delivery proof.

The identical registered case failed on the omitted dependency in 1.324 seconds
and passed after the copy-list fix in 1.331 seconds. Root independently ran it:
one passed in 1.404 seconds. The packet SHA is
`bdf72c282c40e017232e86eb5b3ab3a2caae0abefd54607b9fecd1aa12cd194c`;
root receipt SHA is
`ff1bc6dfc6f25db4a6df5061c6577bfc5a2e016dd223c056ae8fa83206113281`;
independent source/proof review SHA is
`fe3643d48c22d042b3b053ddfe177afd3042388d127b5be14b6f3727352764b0`.
The existing deploy structural gate (`scripts/run-deploy-structural-gates.py`)
runs the complete bootstrap recovery suite. This is distinct from the native
controller gate's default suite list. No new selector, paid probe or verification
framework is added.

The published successor was adopted on the same controller and the one new
guarded canonical recovery returned exit 0. Its source/boot/original-epoch/owner
bound acknowledgment has SHA256
`677a53ced042b297eb59e5d3e213bf310d93ac98e1df5bbfcb2066d34da80f15`.
It records the registry and runtime latch absent, durable pre-config consumption
present, audit status `provider-teardown-verified` and fresh disposition
`destroyed-provider-retained`. The new original log is
491 bytes, SHA256
`0c5f81c8416f823e48e9c37049e7a4ffb9bf2488772b00ff7c6192f0d0b41f68`.
This is the affected original recovery's after outcome, not another proxy test.
Its original source receipts, boot, Git-common directory, data, volume binding
and failed attempts remain separate from the new recovery-tool source.

The missing runtime dependency is fixed on that original recovery path. The
wrapper explicitly does not independently prove provider release, and its
separate sealed-retirement field is not captured. Native object-slot and volume
absence credit require the canonical teardown originals; none is inferred from
exit 0 or an aggregate count change. The original failed task and 600-task
qualification remain unchanged and unverified. New fingerprint policy
registration applies to future stack launches and does not delay recovery-only
execution.

## Human feedback

Continue fixing proven bugs without speculative new Machines or a quota
increase. Preserve warm resources and original evidence. Count actual native
release separately from source tests, stop requests and aggregate count changes.
Keep the original 600-task acceptance and 30-of-600 infra stop threshold.

## Reusable lesson

Exercise required runtime imports through the real sealed launcher, because a valid snapshot manifest can still describe an incomplete payload.
