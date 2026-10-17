---
id: 2026-10-17-managed-worker-app-secret-overrode-queue-binding
date: 2026-10-17
title: Managed worker readiness trusted Machine queue metadata after an app secret overrode the process selector
surface: harness
component: worker-pool-cutover
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: retained_agent_machine.py wrote the unique queue only into Machine config.env, which Fly app secrets override before worker.py reads TEMPORAL_TASK_QUEUE
symptoms:
  - "Machine config has the unique pool base but process TEMPORAL_TASK_QUEUE=navi-agent-tasks"
  - "unique pool queue workflow and activity pollers are empty"
  - "all eight fresh pollers appear on navi-agent-tasks@f125e12cda96 instead"
tags:
  - temporal
  - worker-pool
  - environment-precedence
  - readiness
  - retained-workers
sources:
  - commit 5962c0e3ac0b1cfd945fadafda6a2edd70e39161
  - plan:.context/worker-route5962/.context/route-rca/startup-red.log
repro: scripts/tests/retained-agent-machine.test.py
status: open
---

## Problem

Job 7f67 completed while its eight workers polled the shared generation queue,
not the unique queue published by the controller. ROOT's retained native evidence
shows one worker process with `TEMPORAL_TASK_QUEUE=navi-agent-tasks` despite its
Machine config containing the intended unique base; all eight fresh poller
identities were subsequently observed on the shared generation queue. The
configured pool marker, image, build and ordinary health checks had matched.
The original completed job and all running workers remain unchanged by this RCA.

## Diagnosis

The helper copied the donor configuration and set the unique base in config.env.
Fly app secrets override that map. The worker's dotenv calls use override=False;
config.py reads TEMPORAL_TASK_QUEUE and the pure generation resolver appends the
surface hash. Neither Python nor the Docker CMD repairs the already overridden
selector. The first bad boundary is therefore the controller's launch contract,
not a Temporal build-ID mismatch: the Worker constructor does not opt into native
worker versioning.

The readiness consumer repeated the mistake: it checked Machine metadata and
health phase/build, without observing the process owning the health socket or its
actual queue. Empty legacy DescribeTaskQueue pollers alone were inconclusive, but
the later positive shared-queue poller evidence closed that observability gap.

The April 29 shared-dotenv case concerns a missing local export, whereas this
failure overrides an explicitly supplied Machine config at the provider boundary.
The August 3 cleanup case remains a separate safety constraint: unknown or
misrouted workers may own real work and must never be stopped by default.

## Solution

An isolated candidate binds the unique base after provider environment merging
using the known image startup contract: init.exec runs `/usr/bin/env`, the exact
TEMPORAL_TASK_QUEUE assignment, then `python worker.py`. It rejects unfamiliar
entrypoints, commands, process/container layouts and foreign exec forms. The
image, worker source, global app secrets and serving workers are not modified.

The fixed read-only probe inspects the process owning port 8080, fences its PID
and birth time and the native instance/config version, and uses the image's pure
queue resolver against that process's environment. It returns only whitelisted
route/namespace/build/attempt/autoscaler fields. Preparation requires the actual
unique route and eight exact recent workflow/activity poller identities before
READY, before pointer publication and before completion. Partial poller readiness
waits inside the original 300-second budget; transport/auth/malformed failures are
not silently converted into readiness.

A positive old-bank route mismatch is recorded immutably before PREPARING. The
backend's separately owned atomic holds protect every such managed Machine while
its original active ownership remains intact. The Python controller revalidates
that proof, never stops or releases those workers, and still requires ordinary
qualified retirement of their previously declared queue. The pointer's separately
owned atomic admission fence must reject any raced or unknown prior membership
before publication. No zero-count snapshot is accepted as retirement credit.
The separately owned workflow watch filters must include the extracted runtime
module and backend deployment providers; no qualification/dispatch waiver follows
from that operational wiring.
Standalone helper mutations require canonical lease-owned mutation authority;
read-only inspection and explicit never-managed spare enrollment remain distinct.

### Reproduction and limits

The registered helper test drives the real reserve/reuse function with only its
native transport replaced, applies the documented secret-over-config precedence,
and executes a harmless real subprocess using the production pure resolver.
Unchanged source resolves `navi-agent-tasks@new`; the same test with the candidate
resolves `navi-agent-tasks-pool-fixture@new` and preserves unrelated environment.
The controller owner independently records unchanged readiness accepting wrong
queue/namespace/PID evidence, then verifies the same rejection controls on the
candidate. Original version/ACK/custody assertions remain active.

Exact owning commands, from the isolated candidate root:

```bash
python3 scripts/tests/retained-agent-machine.test.py RetainedWorkerTests.test_managed_startup_overrides_app_secret_without_changing_other_environment
python3 scripts/tests/worker-pool-cutover.test.py WorkerPoolCutoverTests.test_runtime_queue_identity_is_required_even_when_native_config_and_health_match
python3 scripts/tests/retained-agent-machine.test.py
python3 scripts/tests/worker-pool-cutover.test.py
```

The first unchanged selected case fails with actual `navi-agent-tasks@new`
versus expected `navi-agent-tasks-pool-fixture@new`; the SAME command passes after
startup binding. The second initially accepts wrong runtime evidence and then
passes the same negative controls. Full owners pass 32 helper and 27 controller
cases; canonical Ruff, format and compile checks pass. Frozen proof manifest:
`.context/worker-route5962/.context/route-rca/PROOF.json`, SHA256
`b87fce2f9f8e2ac635b537e0f0eff092d8a6666cb740e2d2fc0cad3179d54add` (paths, source/log hashes, commands and limits).

Archive queries `worker queue env secret precedence` (88 matches) and
`generation scoped production cleanup attribution` (142 matches) led to the
April 29, July 1 and August 3 precedents, whose complete solutions and recorded
human-feedback sections were read before implementation. ROOT verified the
provider contracts in [Fly configuration](https://fly.io/docs/reference/configuration/)
(secrets override configured environment) and the
[Machines API resource](https://fly.io/docs/machines/api/machines-resource/)
(explicit init.exec). No web/provider call was made by this source owner.

These are local causal controls, not a production repair or whole-deploy pass.
The composed backend hold/poller/admission implementation, independent audit and
normal whole-source qualification are still required. No native, provider, DB or
production action was performed by this source owner. Status remains open until
that adoption and verification is complete.

At 10k agents this adds no per-agent hot path: coordinator work is bounded by the
eight current candidates and eight retained workers, with no task/model branches.

## Human feedback

None recorded.

## Reusable lesson

Bind worker routing after provider environment precedence and verify the actual serving process before publishing its queue.
