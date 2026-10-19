---
id: 2026-10-14-mocked-owner-proof-used-real-executor
date: 2026-10-14
title: Mocked cancellation ownership proof depended on a real executor queue
surface: agents
component: benchmark-cancellation-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: benchmark cancellation fixture dispatched its mocked exact_root_sessions through the real default executor under a 50ms fixture deadline
symptoms:
  - test_cancelled_preparation_archives_only_with_positive_task_and_owner_proof TimeoutError
  - preparation_snapshot awaited asyncio.to_thread at run_benchmark.py 6187
  - mocked ownership read submitted but not entered before the 0.05-second fixture deadline
tags:
  - cancellation
  - fixture
  - executor
  - ownership
sources:
  - commit a6ae9954c6d93ef1008811775f5750181bf036f1
  - commit b4a926834f4fa79f03b534ad7b96fa8882037015
repro: agents/tests/blackbox/benchmark.blackbox.py
status: mitigated
---

## Problem

The positive cancellation-archive fixture failed with TimeoutError while awaiting its mocked native ownership read through asyncio.to_thread. The fixture uses a 0.05-second deadline; the production default is 60 seconds. The original failing trace did not capture executor submission/entry timing, queue occupancy, or GIL scheduling. Therefore the original scheduling subcause is unknown; this case does not diagnose production executor starvation.

## Diagnosis

The fixture mocked exact_root_sessions but unnecessarily retained the real executor transport. A deterministic controlled reproduction occupied every slot of its own default-size executor with sleeping Event-wait workers, without CPU load, providers, or DB access. The exact existing owning function failed: the fake ownership read was submitted once, entered zero times, and waited 50.334ms at that boundary. The unchanged assertions and deadline passed when only that exact mocked getter ran synchronously through a fixture adapter, while the executor remained occupied. Other to_thread calls continued to delegate to the original implementation.

Evidence: .context/cancelled-preparation-rca-replay.json and .log; .context/cancelled-preparation-control-receipt.json; .context/cancelled-preparation-control-child.py; and .context/cancelled-preparation-rca-report.md. The same child control SHA256 a36c4e5ca23db50a750e280a393280344a83ddfd96d84b144714060b17f5c012 exited 1 against the original fixture and 0 against the proposed fixture. Positive task metadata and all four poisoned ownership/init/task controls remained intact.

Archive searches were `cancellation Mock executor 50ms` and `cancelled run_in_executor starvation test fixture`; the earlier investigator also searched `asyncio.to_thread exact_root_sessions TimeoutError` and `cancelled preparation owner proof thread scheduling0.05`. The July 16 cloud/local contention case is a relative, not a recurrence: it established real workload contention, whereas this case proves only unnecessary executor dependence in a mock. The October 7 cancelled-allocation owner case is also a relative, not a recurrence: its production owner-handle/archive contract is not changed here.

## Solution

Adoption b4a926834f4fa79f03b534ad7b96fa8882037015 changes only the test fixture: intercept to_thread when its function is the exact patched ownership getter, assert the exact URL/root arguments, and call that Mock directly. All unrelated threaded operations retain the original transport. No production scheduling, concurrency, acceptance assertion, fixture deadline, or timeout is changed.

The permanent registered case test_cancelled_preparation_owner_proof_is_executor_independent creates an owned subprocess/event loop and default-size executor, blocks only its own threads, invokes the same owning test, and releases its events in finally. It uses the existing NATIVE_VERIFICATION_TIMEOUT_SECONDS guard. Registration in run_all_tests is present in b4. Recorded reproduction commands from the repo root:

```bash
PYTHONDONTWRITEBYTECODE=1 agents/venv/bin/python .context/cancelled-preparation-rca-replay.py
PYTHONDONTWRITEBYTECODE=1 agents/venv/bin/python .context/cancelled-preparation-control-child.py "$PWD" "$PWD/agents/tests/blackbox/benchmark.blackbox.py"
PYTHONDONTWRITEBYTECODE=1 agents/venv/bin/python .context/cancelled-preparation-control-child.py "$PWD" "$PWD/.context/cancelled-preparation-proposed-fixture.py"
```

The latter two commands share the same child/control and demonstrate original failure/proposed pass; their fixture path is the selected pre/post input. The b4 registered control has an adoption log at .context/adopted-executor-control.log, but that file contains no textual verdict; do not infer a native exit status from its empty contents. Full post-adoption coverage on exact b4a926834f4fa79f03b534ad7b96fa8882037015 exited 0: 110/110 blackbox domains (including both the original owning case and registered occupied-executor control), 184 cache tests, 134 unit tests, and 82% combined coverage. Canonical receipt: .context/deploy-runs/20261014-231509-1930784/logs/agents-coverage-blackbox-20261014-234213-2394192.log. The original failed attempt remains retained. Status is mitigated for the fixture repair, not closure of the original unobserved scheduling subcause or the separate auth/ownership incident.

## Human feedback

The parent required preserving every ownership assertion and deadline, no timeout increase or concurrency reduction, no production starvation claim without evidence, and explicit before/after proof for the same existing owning case. The parent approved the test-only adoption and requested this archive draft under .context while coverage remained frozen.

## Reusable lesson

Remove real executor transport from a mocked synchronous ownership getter while retaining the exact proof assertions and a registered executor-independent control.
