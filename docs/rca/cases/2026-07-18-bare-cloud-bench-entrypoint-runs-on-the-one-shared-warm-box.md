---
id: 2026-07-18-bare-cloud-bench-entrypoint-runs-on-the-one-shared-warm-box
date: 2026-07-18
title: The bare `run-bench-cloud <task>` entrypoint ran on the single shared warm machine, so two worktrees collided and one's teardown clobbered the other's run
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "scripts/run-bench-cloud — resolve_machine_id() pins the ONE machine named cloudbench-warm, so a non-fleet invocation is single-tenant by construction"
symptoms:
  - "on-box /data/bench.log shows a different workspace=…-<pid> simulate=<n> than your controller"
  - another worktree's in-flight cloud bench dies when you run flyctl machine stop
  - two concurrent cloud benches land on the same machine id (e.g. 683e47df)
tags:
  - cloudbench
  - fly-io
  - shared-state
  - footgun
  - multi-workstream
sources:
  - commit 297dddc1f
  - memory:project_cloudbench_shared_warm_footgun
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

On 2026-07-19 a payment slice was launched with `bash scripts/run-bench-cloud
agent-payment-* --no-simulate` directly. `run-bench-cloud` resolves the ONE
machine named `cloudbench-warm` via `resolve_machine_id()` and runs the bench ON
it, so the run landed on machine 683e47df alongside another worktree's
`browser-agent-amazon-cookie-payment --simulate`. The tell was the on-box
`/data/bench.log` showing a DIFFERENT `workspace=…-<pid> simulate=1` than the
local controller. Then `flyctl machine stop 683e47df` clobbered the neighbor's
in-flight run — a rule-27 violation.

## Diagnosis

Two entrypoints share one script but not one tenancy model. The fleet path
(`run-bench-fleet`, reached via `scripts/run-bench`) clones a dedicated ephemeral
machine per bench from a pool of `cloudbench-<hash>` machines; the bare path never
touches that pool and always targets the single fixed warm machine. Nothing at the
boundary distinguished "invoked by the fleet with a cloned machine" from "invoked
by a human on the shared box", so a parallel-unsafe mode was reachable by the most
obvious command, and its teardown (`machine stop`) acted on state it did not own.

## Solution

A guard in `scripts/run-bench-cloud` immediately after arg-parse: if `MODE=run`
and `FLEET_MACHINE_ID` is empty (no `--machine`, i.e. not invoked by the fleet) it
exits 2 with guidance BEFORE any Fly call. `run-bench --single-box` is disabled
with the same message. Admin modes (`--setup`, `--refresh-*`,
`--verify-secrets`, `--destroy`) are exempt because `MODE≠run`; the maintainer
escape hatch is `CLOUDBENCH_ALLOW_SHARED_WARM_RUN=1`. Cemented as scenario 14 of
`scripts/tests/cloudbench-multi-workstream.test.sh`, which `run-predeploy-cloud`
runs. The single parallel-safe entrypoint is `scripts/run-bench <task...>`.

## Human feedback

The human's rule-27 discipline is the frame for this whole case: never stop, kill,
or destroy a shared bench machine you did not clone; verify ownership
(`ps aux | grep run-bench-cloud`, the on-box workspace stamp) before acting; and
if a run you do not own looks stuck, surface it rather than killing it.

## Reusable lesson

If a shared single-tenant resource is reachable from a convenient command, guard
the command — verify ownership before any stop/destroy, and make the
parallel-unsafe mode refuse to start rather than trusting operator discipline.
