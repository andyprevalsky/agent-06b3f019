---
id: 2026-10-06-wmh-implicit-activities-created-child-worlds
date: 2026-10-06
title: Implicit activity callers created a separate child-scoped simulated world
surface: agents
component: world-model-runtime
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: WorldModelToolExecutionAdapter.ensure_session used its acting agent as root when callers omitted an explicit scope
symptoms:
  - "an implicit activity caller split the root world"
  - Payment lookup used the user identity as its acting agent
tags:
  - world-model
  - session-scope
  - temporal
sources:
  - plan:docs/plans/active/wmh-local-continuation-20261006.md
  - commit 17cf59c7e
repro: agents/tests/blackbox/world_model_harness.blackbox.py::test_runtime_world_model_session_is_shared_by_root_agent_tree
status: open
---

## Problem

Explicit specialized callers shared a root-scoped world; implicit provider activities could use a separate child world. Workflow contextvars do not propagate into native activities. Payment lookup also used a user ID as acting identity, risking cross-root state.

## Diagnosis

What: acting identity was mistaken for world identity. Where: adapter session resolution and payment lookup's caller. Why: the default assumed each actor was its root. Proof: the permanent root-sharing blackbox invokes the actual phone activity without prebinding root context. Before repair it created a third session and failed `an implicit activity caller split the root world`; afterward it reused the root session while preserving `gp-child-phone` in its action. Problem: fixture/environment identity mismatch.

Archive searches used `native activity retry duplicate WMH commit root child shared world` and `WMH root session dropped root goal start fixture`. The September 27 unconditioned-session case is a relative; its explicit-call guard missed implicit activities. The old fundraiser had no phone/payment calls, so this does not establish its cause.

```text
activity actor -> durable tree lookup -> root-scoped world
activity actor -> canonical action identity
explicit session/scope -> caller-provided world
```

## Solution

Inside native activities, adapters without explicit sessions/scopes resolve the root through the existing durable agent-flag lookup and fail closed on missing actor/root identity. Seed state carries the resolved root. Standalone conformance retains supplied state. Simulated payment lookup receives an optional browser actor ID; real calls keep their existing two arguments.

The existing per-actor memoization and indexed endpoint provide one bounded cold lookup per actor, with no tree scan or shared tree fan-in at 10,000 agents. Before/after evidence is in `.context/wmh-root-retry-before.log` and `.context/wmh-root-retry-after.log`. Full conformance and fundraiser verification remain pending.

## Human feedback

The user requires one world shared by the root and real GP descendants while retaining each acting agent's identity.

## Reusable lesson

Resolve world scope at native boundaries from durable identity; workflow-local context is not activity state.
