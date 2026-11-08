---
id: 2026-11-08-concurrent-deploy-selector-runpy-module-retired
date: 2026-11-08
title: Concurrent deployment selectors retired another load's temporary module
surface: harness
component: deploy-dynamic-source-loading
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: parallel custody guards loaded the dataclass-bearing selector through runpy under the shared temporary module identity and one load removed another active load's sys.modules entry
symptoms:
  - quick deployment coordinator exited before paid smoke admission
  - dataclasses._is_type raised AttributeError because its module lookup returned None
  - healthy quick sibling processes exited zero with verified quiescence
tags:
  - deploy
  - concurrency
  - python
  - source-binding
sources:
  - PR #1770
  - commit db41fbbed7e8cdd4a4d3ddd3f1ed5b7b5bb6cfca failed quick stage
repro: agents/venv/bin/python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_concurrent_agentcard_selector_keeps_dataclass_module_registered
status: fixed
---

## Problem

The final staged deployment on db41fbbed exited at the coordinator boundary
before any paid smoke request or allocation. Parallel custody guards called
`agentcard_release_stall_task`, which loaded the real benchmark selector with
`runpy.run_path`. The native Python 3.11.9 traceback reached the selector's
`TaskRef` dataclass declaration and failed in `dataclasses._is_type` with
`AttributeError: 'NoneType' object has no attribute '__dict__'`.
The three launched quick siblings separately exited zero and were quiescent;
the coordinator failure remains a failure, without synthesized result credit.

## Diagnosis

Path: parallel staged gate execution -> historical-custody discovery -> catalog
eligibility selector loading -> temporary Python module registration ->
dataclass annotation lookup. Concurrent default runpy calls shared the
`<run_path>` entry in `sys.modules`. One load could finish and remove that
entry while another still needed it for its dataclass declaration. Runpy also
mutated shared `sys.argv[0]`; distinct run names alone would leave that race.

Archive searches used `dataclasses sys.modules None runpy` and `parallel
selector temporary module import`. Their fuzzy matches concerned environment,
selection or unrelated module imports; none described this first-bad boundary.
The earlier source-refresh/no-retry case is related context, rather than a
previously repaired instance of this loader race.

An unchanged deterministic test holds the second real selector load before its
dataclass annotation lookup, lets the first load finish, then releases the
second. The original loader fails with the same dataclass exception on the
actual Python 3.11.9 interpreter. It is a native thread interleaving, without
fabricated status, timing-only assertions or reduced gate concurrency.

## Solution

Use one fresh-source module context for the selector and the sibling retained
native-audit helper. Each call creates a unique importlib module identity,
registers it before execution, compiles current source bytes directly, retains
the entry through the predicate/audit calls, and removes only its own entry in
`finally`. It does not modify process-global argv or path, cache task inputs,
or reuse timestamp/size-based pyc code.

Catalog eligibility, sandbox/production checks, task inputs, audit tree digest,
registry ownership and all custody comparisons remain unchanged. No provider
observation, resource mutation, skip, PASS or financial-release credit is added.

## Verification

The identical concurrency reproduction fails on the original loader and passes
after the change on Python 3.11.9. Additional controls cover argv/path/module
ownership, exception cleanup, foreign replacement entries, catalog/root
isolation and same-size source changes with a restored mtime and a real stale
pyc. Concurrent real native-audit checks preserve exact original hashes and
refuse corrupt trees, live registries and live owner metadata. The two actual
historical native audits also validated concurrently without provider calls.

The retained focused result is four passing tests. The exact final source passes
216 coordinator tests on Python 3.11.9 in 87.686 seconds and seven cloud adapter
tests. The unchanged staged deploy command must still qualify this new source;
these causal and coordinator results do not claim a full deploy pass.

## Human feedback

The user requested autonomous completion of RCA and deployment. No instruction
authorized weaker custody checks, reduced concurrency or another payment-card
attempt after a confirmed stall.

## Reusable lesson

Own each dynamic module's registration for its full use lifetime, and read fresh
source without changing shared interpreter state in concurrent validators.
