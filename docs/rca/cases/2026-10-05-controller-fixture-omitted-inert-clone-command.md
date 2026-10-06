---
id: 2026-10-05-controller-fixture-omitted-inert-clone-command
date: 2026-10-05
title: Controller fixture omitted native clone command and finished before worker faults
surface: harness
component: cloudbench-controller-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The fake clone provider omitted the requested config.init.cmd consumed by the real inventory index
symptoms:
  - a fleet must fail when an autoscaled worker clone cannot launch
  - waiting for native inert clone command
  - configured launch rejection never reached its SSH handler
tags:
  - cloudbench
  - controller
  - fixtures
  - ownership
  - regression
sources:
  - commit 271ca1cfaca0ee62a57662c90393349f8dc249f0
  - task canonical cloudbench-multi-workstream deployment gate
repro: scripts/tests/cloudbench-multi-workstream.test.sh scenario 2d
status: fixed
---

## Problem

The full controller fixture reached scenario 2d after ten successful scenarios,
then rejected a successful fleet exit: its configured worker-launch fault had
never executed. An earlier primary completed while the future worker was still
inert, allowing the production controller to cancel unneeded staging correctly.

## Diagnosis

The original full run failed in 330.246 seconds. Its retained state contained
no launch rejection. A read-only reduction confirmed that the fake driver could
finish in 0.036 seconds before the rejection handler. A private causal handshake
then exposed the earlier missing provider field: worker stages repeatedly waited
for an inert clone command and never issued SSH launch.

The real controller requested `--override-cmd "sleep infinity"`. The fake clone
handler modeled mounts and VM resources but omitted `config.init.cmd`; the real
inventory index therefore correctly reported `clone_cmd_inert=0`. Falling-demand
fixtures also lowered demand on clone allocation, before the fault they claimed
to exercise. No lost production launch failure was observed.

## Solution

Have the fake provider project the requested override command into its returned
configuration, leaving absent overrides absent. Extend its existing compact
provider contract to send requested and absent commands through the real native
index. The new owning assertion failed against the original provider in 0.908
seconds and passed against the faithful provider in 1.658 seconds; existing
volume and private-address inverse controls remain unchanged.

Keep the fake primary alive until the actual configured launch rejection or
success handler publishes its owned marker. Lower the oscillating target only
after that boundary. A pre-supervisor rejection can then preserve task PASS
while the fleet reports missing runtime evidence, without waiting for a
successful scale-down that evidence retention deliberately forbids.

The copied real controller also imports the standard-library-only
`outcome_publication.py`; copying that current dependency beside `hub_upload.py`
removed a publication failure in the hermetic worktree. An audit of controller
entrypoints and the five copied helpers found no further local dependencies.

All existing fleet failure, launch-stderr, ownership and teardown assertions and
deadline values remain unchanged. Production late-inert cancellation stays
unchanged. The corrected private owning 2d and pre-supervisor 2g controls passed.
The post-supervisor variant passed its unchanged assertions on native Linux in
39.17 seconds. Its Mac attempt was preserved as a platform failure: the real
worker supervisor requires Linux subreaping. The complete controller gate runs
on the existing native Linux image before deployment.

## Portable native verification

Faithful post-supervisor fixtures execute the real Linux subreaper; running them
on Mac is not a valid substitute. The standard fixture command now dispatches
Mac hosts through the committed small Python3.11.9/Node22.13.0 Docker recipe,
reuses its fingerprinted cache, and runs the unchanged Linux body without network
access or writable source mounts. An explicitly selected existing image must
pass the same platform and tool checks. The recipe itself was not rebuilt for
this receipt; the existing local image passed those checks.

The actual cached owning control passed in 6.402 seconds. An actual SIGTERM
cancellation passed in 6.027 seconds: the exact owned container was absent and an
unrelated control container remained live. Five compact controls protect matching
and foreign ownership, missing and malformed CID handling, plus inherited proxy
settings and the dispatch-to-retirement identity. Their inverse caught a private
proxy-loop variable shadowing error before the runner was applied. Private failed
cancellation receipts remain retained. Runtime and controller budgets did not
change.

## Human feedback

Use a compact deterministic owning reproduction, batch proven fixture causality
fixes, preserve task PASS and fleet infrastructure assertions, and retain the
original red receipts. Do not weaken production cancellation policy or deadlines.

## Reusable lesson

A fake provider must retain the declared configuration that a real consumer
validates. Fault tests must synchronize on the actual handler, rather than
allocation or scheduler timing before the fault boundary.
