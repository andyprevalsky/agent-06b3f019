---
id: 2026-09-30-cloud-controller-fixture-node-major
date: 2026-09-30
title: Native controller launcher selected Node 20 for a Node 22 hermetic seed fixture
surface: infra
component: private-cloud-controller-gate-launcher
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: private Linux gate launcher activated the Python venv but inherited the Machine exec default Node 20 PATH
symptoms:
  - "bad option: --experimental-strip-types"
  - "Missing canonical base fixture for cloud guests"
  - "workstream A's provisioning must succeed alongside a concurrent run (exit=1)"
tags:
  - cloud-fleet
  - node-22
  - fixture
  - canonical-seed
sources:
  - PR #1299
  - commit 05a722cc77a232b4699d92bc6542df7966ff5fd6
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

The first rerun of the repaired mandatory Linux lifecycle fixture stopped after
34.83 seconds, during concurrent provisioning and before any benchmark allocation.
Both controllers failed canonical seed admission. The private launcher activated
the agents venv but omitted the already installed pinned Node toolchain from PATH.
Native metadata showed its selected Node was 20.20.2; Node 22.13.0 was available.

## Diagnosis

The owning hermetic seed-cache stub is a TypeScript file executed by its real
fixture shim with `node --experimental-strip-types`. Node 20 rejects that flag,
so the stub cannot create the required synthetic dump. Seed admission correctly
fails after its bounded attempts. This is a launcher configuration defect;
neither the real published canonical dump nor production admission was missing.

Archive searches were `bad option experimental-strip-types node cloud canonical
seed` and `Node 20 hermetic seed stub provisioning fixture`. The historical Node
20 WebSocket gate is a related runtime-capability mismatch at a different boundary.

The executed reduction extracts the exact checked-in SEEDSTUB and invokes it with
the same arguments on both installed Node binaries. Node 20 returns 9 and creates
no dump; Node 22 returns 0 and creates the unchanged 32-byte fixture dump. Only the
selected executable changes. The full unchanged native gate passes every lifecycle scenario with the pinned
toolchain in 1233.56 seconds on commit `05a722cc77a232b4699d92bc6542df7966ff5fd6`.
Its receipt binds suite SHA256
`c38abb956827a961349f090e87d2ea30fcd30fff2dd7bd7f6fa02fa93c4bcb9d` and
contract SHA256 `24c235797731eb96fddd16c78306b62d7d27a78c92931f308e822d4bd7eb08d1`.
This fixture outcome supplies no fleet credit.

## Solution

Prepend the existing Node 22 toolchain and helper binaries to the private native
gate launcher's PATH while activating the agents venv. Use a private 0700 temporary
directory on the verified controller data filesystem, outside the checkout, and
retain all existing concurrent reserve/headroom requirements. No installation,
production source change, fake response change, timeout change, or task change is
needed. The checked-in mandatory lifecycle suite retains the real hermetic seed
admission as its permanent owning regression.

The exact full source and fixture hashes are captured by the gate receipt. The full native suite and independent review both pass. Production execution
cost is unchanged.

## Human feedback

Inspect usable setup before reinstalling or resetting it, use the pinned
Node 22.13.0, and finish every proof criterion without accepting diagnostics.

## Reusable lesson

Bind both the Python environment and Node toolchain explicitly when launching hermetic controller gates through Machine exec.
