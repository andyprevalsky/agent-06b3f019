---
id: 2026-10-01-worker-clone-booted-primary-before-neutralization
date: 2026-10-01
title: A worker clone booted its copied primary command before worker staging could neutralize it
surface: infra
component: cloudbench-worker-provisioning
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: clone_machine_target submitted the primary startup configuration to an immediately launching Machine clone before provision_worker could replace its command
symptoms:
  - "Unable to create '/data/repo/.git/index.lock': File exists"
  - "worker did not reach queue readiness within 300s"
  - "cloudbench-boot.sh started before neutralize cloned boot command"
tags:
  - cloudbench
  - worker
  - clone
  - startup
  - git-lock
sources:
  - PR #1299
  - fleet run 20261001-223923-18219
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_clone_creation_cannot_start_copied_primary
status: open
---

## Problem

The diagnostic's primary task evaluated FAILED, which is allowed by the proof
contract. Its autoscaled worker failed before joining the queue: retained worker
evidence reports an existing Git index lock and an unverified requested ref.
Provider logs establish that the worker first started the copied primary boot
command at 22:51:36.769 UTC. The later neutralization update began at 22:51:41;
the initial boot received SIGTERM at 22:51:47, and the inert command started at
22:52:04.504. Worker staging could not prevent work that had already begun.

The exact moment the Git lock was created was not captured. This repair proves
and prevents unintended initial primary execution; it does not claim that the
provider timeline alone proves how the abandoned index lock arose. The
retired-worker finalizer wait is documented in its separate owning case.

## Diagnosis

The path is primary configuration → provider clone/create → immediate guest
startup → storage-ready observation → neutralization update → worker bootstrap.
The source configuration's native archive contains only `init.cmd`, naming the
primary boot script, with its boot flag enabled. The snapshot and source/target
Machine identities are bound by the original clone log.

The installed Fly CLI's clone implementation copies source configuration,
launches the new Machine and only then honors `--detach` by skipping its wait.
It does not interpret detach as skip-start. Its `--override-cmd` changes only
`Init.Cmd`, so inherited `Init.Exec` or `Init.Entrypoint` must be rejected before
using that override. The controlled warm image itself has no image entrypoint.

Archive searches were `index.lock already exists worker`, `worker clone boot
command`, and the literal `index.lock`. The July 16 per-box launch case is a
relative: it moved primary startup onto the boot path and discussed interrupted
Git locks, but did not fence creation of autoscaled clones. A later configuration
update cannot establish a before-first-start invariant for an API that starts
during creation. This is the deepest proven wrong boundary, independent of the
uncaptured lock-creation event.

The owning regression publishes the real native inventory index and runs the
actual cloner and inventory reader. Its provider boundary models the observed
immediate startup by executing the copied application command, which writes a
marker. All three variants failed before the runtime edit because that write
occurred. The same command passed unchanged after the repair:

```bash
cd agents
source venv/bin/activate
python -m pytest -q benchmarks/cloudbench_dependency_sync_test.py \
  -k clone_creation_cannot_start_copied_primary
```

The variants cover ordinary CMD inheritance and rejection before allocation
when Exec or Entrypoint takes precedence. The provider fixture shortens only
the inert sleep; it executes copied application commands unchanged. Private
before/after logs report 3 failed in 3.17 seconds and 3 passed in 3.25 seconds.
Independent review reran all three plus native-index publication: 4 passed.

## Solution

Create clones with `--override-cmd "sleep infinity"`. The existing shared
provider inventory publishes whether CMD can be overridden safely; the cloner
requires that affirmative field before recording or allocating a target.
Missing/unhealthy inventory and incompatible startup shapes fail closed. This
adds no provider read or separate observer. Preserve the existing staging update
that clears the inherited boot flag.

This moves the startup invariant to resource creation rather than adding a
recovery path after unintended execution. Removing the later boot-flag reset
would weaken restart hygiene; removing the source-shape check would allow an
inherited Exec to ignore the inert CMD. Neither is a sound simplification.

The compact regression is included in the existing benchmark blackbox native
completion gate and Linux controller deploy selector. Native live verification
on the final repaired source remains pending; this case stays open. Neither
this causal proof nor diagnostic evidence publication earns acceptance credit.
The original primary browser-injection timeout remains a separate open finding.
Its original worker's copied boot began at 22:03:07 UTC, over six minutes after
the last injection timeout at 21:56:41. Independent native-log review therefore
rules out that worker's application execution as the cause of those timeouts.

## Human feedback

The user requires zero infrastructure errors while permitting genuine benchmark
FAILURE, preserves all harness timeouts, and requests compact, effective runner
regressions. Do not turn diagnostic or recovered runs into acceptance credit.

## Reusable lesson

Make cloned resources inert in their creation request before any copied
application startup can run.
