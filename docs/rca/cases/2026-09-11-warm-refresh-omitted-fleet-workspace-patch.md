---
id: 2026-09-11-warm-refresh-omitted-fleet-workspace-patch
date: 2026-09-11
title: Warm dependency maintenance fetched the base but omitted the fleet workspace patch
surface: infra
component: cloudbench-warm-dependency-refresh
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: warm_deps_preflight passed only the fetchable base ref before the fleet workspace patch was prepared
symptoms:
  - "remote dependency state did not match the exact local ref/fingerprints"
  - "central dep refresh failed; refusing to provision task machines"
tags:
  - cloudbench
  - dependencies
  - workspace-patch
  - source-provenance
sources:
  - PR #1299
  - fleet run 20260911-012110-43590
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_refresh_deps_applies_exact_workspace_before_rebuild
status: open
---

## Problem

The exact polar-bu-034 worker-shutdown retry on commit 64580d973 aborted before
allocating any task Machine. Adding the Temporal gRPC test dependency changed
requirements.txt. Central maintenance fetched main c5ea2229255, rebuilt its
dependencies, then correctly rejected a mismatch with the controller's branch
requirements. No agent executed; this retry contributes no acceptance slices.
The maintenance cleanup parked the protected warm source. Private evidence is
`.context/acceptance/polar-worker-exit-live.log` and its active-run metadata.

## Diagnosis

The expected Python manifest fingerprint was
4e3d28b69f0d3c23837eb2d3cca15500f18624f4ae94a8809d15d758be2f2a47;
the fetched base produced
ecbcc49336f3e3ca0f0854320ec23289adcfb1732d3eb9e96b48ad849f629c78.
Both Git ref checks and Node fingerprints agreed. The controller deliberately
maps unpublished commits to a reachable main ancestor, then ships the full
workspace delta to guests. Its warm preflight ran before that patch existed and
passed only the ancestor to maintenance, which never applied a patch. Expected
fingerprints therefore described a different source tree from the one installed.

The local regression executes the actual maintenance mode with real Git repos,
a committed feature requirement, the canonical patch generator, and a local SSH /
SFTP boundary. Install and provider calls are replaced by observable stubs. The
unchanged pre-fix mode fails both pinned and direct feature cases after building
the wrong requirements. It also attempts installation for invalid-patch cases.
The final pre-fix log records five failures and two passes; the controls that
already passed were a failed fetch and no source delta. This proves the source
handoff defect without relying on a live provider or dependency installer.

Archive searches covered dependency fingerprint, refresh-deps, dependency patch,
and exact local ref. The July 15 baked-donor mismatch case describes the earlier
lack of a matching donor; the August refresh cases repair authentication and
transport. Those guards remain useful, but this is a distinct first-bad boundary
in the later central maintenance path: it omitted the source delta entirely.

## Solution

Freeze the fleet patch before warm preflight. Pass that same file and pinned
checksum to central maintenance and every task guest. Maintenance checks the
controller checksum before touching the warm source, fetches the reachable base,
uploads the patch and current patch-preparation helper, verifies the remote
checksum, and applies the patch before rebuilding dependencies. Direct maintenance
uses the canonical generator against its requested ref, including committed
changes absent from that ref. Empty deltas remain valid; failed fetch, invalid
checksum, and patch conflicts cannot install dependencies or publish a snapshot.

Staging uses invocation-owned files outside the checkout and removes only those
files. Existing exact ref/fingerprint checks, warm-source lease, confirmed stop,
and exact completed snapshot publication remain required. The fleet still
requires dependency edits to be committed and task guests still never install
dependencies from the network. Normal benchmark backstop remains 7200 seconds;
the requested live validation remains 300 seconds. No readiness, recording,
controller catch-up, or provider capacity bound changed.

The seven-scenario regression is registered in the permanent benchmark blackbox
and deploy controller gate. The existing fleet preflight test also verifies that
the pinned patch survives the subprocess handoff. Evidence logs are
`.context/acceptance/warm-refresh-workspace-before-final.log` and
`.context/acceptance/warm-refresh-workspace-focused.log`.
The focused maintenance suite passes 25 cases on macOS; 41 patch, refresh,
and boot cases pass on Linux, and the full Linux benchmark blackbox passes.
Independent RCA review reran nine source/handoff/ordering cases successfully
and found no source-binding, cleanup-ownership, or relaxed-bound issue.
Live maintenance on e42b11d6e passed all ref/fingerprint checks, stopped the
warm source, and published exact snapshot vs_a56XkOMV2e9h80PZ66x. The required
canary subsequently exposed a separate exact-ref fast-path defect: the dirty
snapshot worktree was treated as clean and patched twice. See
`2026-09-11-exact-ref-fast-path-retained-patched-worktree.md`. No Polar task ran.
Live retry, exact teardown, durable evidence, and the ten consecutive ten-task
slices remain required before closing this case.

## Human feedback

Finish without repeated permission requests. Preserve a normal 120-minute
backstop and temporarily use five minutes for this validation. Count only ten
consecutive sequential cloud slices with no infrastructure errors, verified
teardown, and durable evidence. Explain deploy benchmark selection and a global
cap of twenty after completion; do not substitute that explanation for execution.

## Reusable lesson

Build shared dependencies from the same checksum-pinned base-plus-patch source that every task guest executes.
