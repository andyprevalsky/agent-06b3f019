---
id: 2026-09-10-macos-isolated-benchmarks-forced-shared-postgres
date: 2026-09-10
title: A Linux database override forced isolated macOS benchmarks onto shared system Postgres
surface: harness
component: local-benchmark-startup
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/benchmarks/local.py start_services uses os.name != nt for a Cloud/Linux-only system Postgres override
symptoms:
  - "Batch workflow start failed"
  - "Too many database connections opened: FATAL: sorry, too many clients already"
  - "1/50 children failed. See structured_response.items for per-child results."
  - "ROSE_USE_SYSTEM_PG=false becomes true on macOS"
tags:
  - benchmarks
  - macos
  - postgres
  - database-isolation
  - platform-selection
sources:
  - PR #1299
  - commit 94d077aae83474f9d63fd092b6c9f920d090f3e4
  - agent 0b4c3920-33c5-4b74-a6c9-7a280fe97611
  - hub run c9d3f3b8-4ea0-4104-b6dc-b70b0d8cbad1
repro: agents/tests/blackbox/benchmark.blackbox.py::test_local_start_services_limits_automatic_system_postgres_to_linux
status: open
---

## Problem

The local mass-agent deploy smoke used system Postgres on port 5432 despite
running on Andy's Mac, where the documented setup uses a per-workspace Docker
database. Its exact manifest was
`.context/benchmarks/1789083802-23327-54327/services.json`:
`use_system_postgres=true`, database
`victoria_bench_1789083802_23327_54327`.

At `2026-09-10T23:44:22.260Z`, that stack's `logs/backend.log` recorded
`[AgentsBatch] Batch workflow start failed` for child
`a1ad45a5-efe8-4bfe-a865-a76bce84cf0b`, with
`Too many database connections opened: FATAL: sorry, too many clients already`.
`logs/worker.7.log` recorded the same child's failure at
`23:44:22.396849Z`. The row remained `STARTING_UP`, last updated at its
`23:44:21.729Z` creation, with only its initial message. The parent eventually
received the explicit `1/50 children failed` result.

The smoke's actual timeout was **900 seconds**, as printed by the launcher:
`test-mass-agent-run-0 → 900s (default; history n=1/5)`. The catalog's 600-second
value is raised by the existing task timeout floor. An 800-second report alone
was therefore not a timeout failure. The unchanged run subsequently failed;
the other six smoke cases passed.

## Diagnosis

`start_services()` describes its automatic system-Postgres override as a
Cloud/Linux workaround for unavailable Docker overlay mounts. Its predicate
was `os.name != "nt"`, which also matches macOS. It set the subprocess's
`ROSE_USE_SYSTEM_PG` to `true` when absent or explicitly `false`. This bypassed
`run.sh`'s normal Docker selection before Docker health or exact workspace
ownership could be considered. Separate database names still shared one
server's connection admission limit.

The batch had created its rows before the workflow-start phase. The exact
error came from `agentBatchService.ts::runPhaseTwoStarts`, which invokes
`executeDescendantWorkflowStart` for each child. The worker received that
child's failed-start result and did not wait indefinitely for it. This locates
the first observed runtime error at workflow-start admission, rather than
inside a creator's research or a provider browser.

Later observations are distinct from that admission error. After the batch
failure, the root launched repair work. A code-agent call completed at about
`23:50:02` with no requested CSV attachment and zero extracted artifacts. A
different general-purpose child, `ce0d282e-04c6-4e60-b64a-8dd9ec8b9415`, entered
`wait_for` call `toolu_013ZjzMio8b2NB2677psSenQ`. Seven checks from `23:50:53`
through `23:58:18` reported no evidence that an explore agent had returned its
results. Those condition-check activities continued finishing, so worker
inactivity was not the explanation. Neither later behavior has been proven
fixed by changing database selection.

Archive search `macOS system Postgres isolation database connections` found
the related July local-test resolver case and August Docker-probe/seed-major
case. Their owning boundaries differ: this launcher unconditionally applied
a Linux-specific override on Darwin, even with explicit Docker preference.

## Solution

Restrict the existing automatic override to `sys.platform == "linux"`.
Darwin now passes through an absent, false, or true setting. The existing
`run.sh` path chooses its per-workspace Docker database by default, while an
explicit system-Postgres opt-in remains available. Linux automatic selection
is unchanged. The fix is one conditional and adds no per-agent work.

The owning regression calls the real `start_services()` and captures its
subprocess environment at the launch boundary. Only the external subprocess
and readiness boundary are replaced. It verifies all five platform/config
cases, preserves the caller environment, and checks the isolated workspace
and canonical run command. It is registered in the existing benchmark
blackbox suite as `local_start_services_database_platform_selection`.

The exact command, run before and after the one-line fix, was:

```bash
agents/venv/bin/python - <<'PY'
import runpy,sys
sys.path[:0]=['agents','agents/tests/blackbox']
module=runpy.run_path('agents/tests/blackbox/benchmark.blackbox.py')
module['test_local_start_services_limits_automatic_system_postgres_to_linux']()
print('PASS: isolated database platform selection (5 cases)')
PY
```

Before: Darwin unset and false both became true, failing the final assertion.
After: all five unchanged cases passed. Evidence is retained in
`.context/acceptance/local-database-platform-repro.log` and
`.context/acceptance/local-database-platform-fixed.log`.

**Causal platform proof complete; benchmark outcome pending.** Docker creation
currently uses `postgres:16-alpine` without a `max_connections` override. This
change restores server isolation; it does not increase per-server capacity.
The failed run's database had already been removed by canonical teardown when
the follow-up read-only capacity query ran, so no historical per-stack
connection count is claimed. The unchanged mass-agent rerun must verify the
actual selected Docker database and sample its connection usage during fan-out
before concluding isolation is sufficient. Its canonical PG16 fixture must
preserve the reviewed data. Shared system Postgres must not be restarted or
reconfigured to make this one run pass.

## Human feedback

The user required the documented Mac/Docker setup and completion without
repeated permission requests. Prompts, task catalog, evaluator criteria,
cache contents, and timeouts must not be changed to hide incomplete children.

## Reusable lesson

Apply platform-specific service fallbacks only to the named platform, preserving
explicit caller configuration and the intended resource-isolation boundary.
