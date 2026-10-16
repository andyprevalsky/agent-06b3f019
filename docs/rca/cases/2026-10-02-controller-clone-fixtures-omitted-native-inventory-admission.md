---
id: 2026-10-02-controller-clone-fixtures-omitted-native-inventory-admission
date: 2026-10-02
title: Isolated clone fixtures omitted the real native inventory admission dependency
surface: harness
component: cloudbench-controller-test-fixtures
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Isolated tests invoked the real clone command without providing its native inventory reader and source Machine metadata
symptoms:
  - "machine_creation_admission: command not found"
  - "inventory_machine_field: command not found"
  - "production clone command builder failed in the capacity replay"
  - "test_exact_volume_ownership_survives_delayed_visibility_and_failed_delete returned 21"
  - "shared inventory snapshot did not initialize"
tags:
  - cloudbench
  - fixture
  - inventory
  - exact-ownership
sources:
  - PR #1525, October 16 environment fixture recurrence
  - PR #1299
  - commit e5586839726b96306ebbf9b45a619774bb5db630 (native Linux Step 4cb batch)
  - PR #1450, exact 9712327589e7ac51c5b8abb2cf1459e9e374ed8f command registry
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_volume_ownership_survives_delayed_visibility_and_failed_delete
status: fixed
---

## Problem

The existing native Linux controller deploy batch completed all fourteen sibling
commands in 321.201 seconds. Eleven passed and three failed. Two failures came
from isolated clone fixtures; the third, gzip parsing in the fake Hub, has its
own case. The original batch remains FAIL, with no fleet acceptance credit.

## Diagnosis

The environment shell control printed the missing `inventory_machine_field`
error before its capacity assertions. The exact-volume Python control suppressed
clone stderr and exited 21 when no ownership record appeared. Its retained
fixture had no provider-call file. This second log did not expose a shell
command-not-found message; the missing dependency was identified from source
and then confirmed by the unchanged isolated reproduction.

Both tests extracted `clone_machine_target` without its native inventory
collaborator. Production now requires affirmative source startup metadata before
recording or allocating a clone. The guard therefore rejected the incomplete
fixtures before they could reach the intended capacity or volume-recovery path.
The genuine CMD/Exec/Entrypoint admission controls already covered that guard.

Exact-error and behavioral archive searches found
`2026-10-01-worker-clone-booted-primary-before-neutralization`, which explains
why the production admission check must remain. No live provider failure or new
teardown defect is established by these fixture errors.

## Solution

### 2026-10-16: worker claim fixtures omitted the new explicit-idle helper

The existing worker terminal family passed 27 cases and failed three after the
new claim dispatcher was added. Its extracted shell omitted
`claim_explicit_idle_worker`, yielding `command not found`; the minimal empty
inventory fixture also lacked the current owner/dependency context. The real
CLI supplies both before reaching this boundary.

Include the actual new helper in both extracted call graphs and bind the
existing caller's owner and dependency fields in the minimal fixture. Preserve
the no-create, exclusive claim, return and interrupted-release assertions. The
same three cases failed with the original fixture, then passed five unchanged
runs; the full 30-case family passed. Production files were unchanged by this
fixture repair. Logs are retained in `.context/worker-fixture-closure`.

Publish explicit started, CMD-only source Machine JSON through the actual
`cloudbench-machine-readiness.py --publish-index` helper. Extract the production
inventory health, record-path and field readers alongside the real cloner.
The fixture shell owns the publisher identity and reads its generated health
metadata. Do not replace admission with an unconditional affirmative stub.

The existing exact-volume command failed unchanged in 3.697 seconds, then
passed in 3.306 seconds after the fixture correction. All nine Python ownership
assertions are unchanged. The full existing environment shell control passed in
26.702 seconds, retaining its CPU-capacity and native-command assertions.
Both controls are already registered in canonical deploy Step 4cb.

Original logs, source bindings and retained failed fixtures were archived
privately with SHA-256
`56b6ebf18b5186b2079bde0c169b2d94898fe5a7bea592f7e6933db6d7946091`.
The original sixteen recorded native owners were absent. Final candidate
verification found all six recorded identities absent, no owned process-group
or fixture-path member, and the temporary multi-workstream fixture removed.
Production code and all deadlines are unchanged. The final normal deploy gates
and the separate hundred-benchmark acceptance campaign remain pending.

### 2026-10-08: a repeated-demo fixture omitted parent campaign dependencies

The exact `97123275` normal command registry passed 44 of 45 owners. Its
benchmark compact owner passed 520 controls, skipped four existing platform
cases, and failed the repeated-demo control's original zero-exit assertion.
The retained campaign had `shared_inventory_failed: true`, peak concurrency
zero, and two cancelled members with no child exit codes. The native publisher
reported `shared inventory snapshot did not initialize`; no fake fleet ran.
Initial Hub publication also remained pending. These are fixture evidence,
not a failure or latency measurement of a LIVE benchmark.

Literal-error and behavioral archive searches found this admission-fixture
case plus the campaign-wide inventory and Hub membership owners. The prior
clone correction held, but did not cover another isolated caller: the demo
test replaced fleet children while leaving the real parent dependent on host
Fly inventory and Hub configuration. Its intended cache-policy assertions
therefore depended on unrelated external availability.

The existing repeated-copy command, with an offline transport refusing
unprovided native reads and a loopback Hub, failed at the same zero-exit
assertion in 1.951 seconds. From `agents/` with `source venv/bin/activate`,
the command is `python -m pytest -q benchmarks/cloudbench_demo_cache_test.py -k
repeated_copies_keep_guard_and_existing_topology` on both revisions.
Supply the parent's external collaborators in
`launch_probe`: a read-only fake Fly client accepts only Machines/Volumes list
and returns valid empty inventory, and the existing Hub transport fixture
receives real parent publication. Keep the real inventory producer, ownership,
admission, scheduler and cleanup active. Override only this test child's
transport credentials and URL; no host credentials or production service are
needed. Close the loopback server in `finally`.

The same focused command then passed in 3.508 seconds. All original assertions
and host guards remain; the repeated-copy control additionally checks that
inventory initialized and its owner retired. The entire existing nineteen-case
demo-cache family passed in 10.741 seconds. It remains selected by
`scripts/tests/benchmark-live-results.test.py` in normal deploy, without a new
test stage, provider/model calls, or production/runtime changes. Production
release, final composed gates and the five width-fifty LIVE streak remain
separate required evidence. At ten thousand agents this fixture-only repair
adds no runtime work.

### 2026-10-16: capacity replay omitted the new allocation gate

During PR #1525 verification, the existing registered environment suite failed
with `machine_creation_admission: command not found`, followed by
`production clone command builder failed in the capacity replay`. Its isolated
fixture extracted the real `clone_machine_target` but omitted its new admission
dependency. The production gate deliberately returns 78 because authenticated
measured creation admission is unavailable; this was a fixture failure, not a
provider failure or a cause of the original REAL600 outcome.

The same command was used before and after, with Python 3.11.9 on PATH:

```bash
PATH="/home/boxes/rose/agents/venv/bin:$PATH" bash scripts/tests/cloudbench-env.test.sh
```

The RED receipt is
`.context/pr1525-continuation/worktree-symlink-rca/env-fixture-pinned-red.json`
(exit 1, test SHA256
`6e71e8a258ff393a39bf25ad59796befc78a3cd088616600f7fef896de0415f5`).
The repair loads the real gate and asserts exit 78, the refusal explanation,
and no fake-provider call or target-ledger publication. Only then does an
explicit fixture-only admission double accept the exact fake-provider ledger
for the original CPU/memory command-builder replay. The full production cloner
and all existing shape assertions remain intact; no production guard changed.

The next full run exposed a separate missing Gitcommon fixture dependency,
recorded in `2026-09-10-recovery-fixtures-omitted-controller-bootstrap`. After
that correction, the identical registered command passed with terminal output
`All cloud benchmark environment checks passed.` The GREEN receipt is
`env-fixture-pinned-green.json` in the same directory (exit 0, test SHA256
`ad52ba01f17b1d59f20e31763a528c580f72b2c755b338edd31e4520bced6da6`).
Original stdout/stderr and the exact diff are retained beside both receipts.
This adds no production behavior or runtime cost, and supplies no original600
qualification credit. Archive searches for the literal error and capacity
replay found this existing case; no new runtime mechanism was proposed.

## Human feedback

Keep effective existing controls small, preserve real ownership assertions, and
repair setup drift without weakening production admission or inflating timeouts.
Genuine evaluated task FAILURE remains acceptable; test setup failure does not
provide passing deployment or fleet evidence.

## Reusable lesson

An isolated caller of a production function must supply its real admission
contract before assertions about a later boundary can be meaningful.
