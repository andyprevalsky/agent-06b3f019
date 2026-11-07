---
id: 2026-11-07-campaign-launch-record-omitted-effective-cloudbench-operator-settings
date: 2026-11-07
title: A --durable campaign's CLOUDBENCH_* operator settings lived only in its systemd unit environment, so a successor relaunch silently used defaults
surface: infra
component: run-bench-campaign-launch-record
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: scripts/run-bench-campaign.py main() wrote the launch summary.json (and printed its banner) without the effective CLOUDBENCH_* environment; scripts/run-bench --durable carried those settings only into the transient unit's --setenv list
symptoms:
  - "❌ capacity admission remained blocked for 300s"
  - "❌ Machine-count capacity admission denied: 63 app Machines"
  - native infra stop at 1/9 on a successor relaunch of a campaign that previously ran with CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS=3600
  - CLOUDBENCH_WARM_STOP_ATTEMPTS / CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_SIZE visible only via `systemctl show <unit> -p Environment`, not in summary.json
tags:
  - cloudbench
  - campaign
  - durable
  - systemd-run
  - provenance
  - reproducibility
  - capacity-admission
sources:
  - benchmark run campaign-20261107-211039-3331466 (epoch20; unit run-bench-20261107T211039Z-3331434)
  - benchmark run campaign-20261107-225538-1478726 (proof-B successor; r001-j0003.log line 453)
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py::test_campaign_inventory_normal_cli_records_nonsecret_operator_settings_at_launch
status: fixed
---

## Problem

Descend cluster I-31, run descend-failed-neverrun-20261106. The epoch20 campaign (`campaign-20261107-211039-3331466`) was launched with
`scripts/run-bench <8 tasks> -k 2 --concurrency 8 --durable` and the operator
overrides `CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS=3600`,
`CLOUDBENCH_WARM_STOP_ATTEMPTS=720` and
`CLOUDBENCH_FLEET_BUNDLED_FRONTEND_VM_SIZE=performance-2x`. Read with a
name allowlist, `systemctl show run-bench-20261107T211039Z-3331434 -p
Environment` was the only place they existed. The campaign's `summary.json`
top-level keys were `campaign_id, started_at, finished_at, status, runs,
concurrency, task_count, total_jobs, peak_concurrency, jobs, retry_infra,
e2e_*, shared_inventory, campaign_canary_receipt, wall_clock_seconds`. No
campaign file mentioned any `CLOUDBENCH_` name.

A successor owner relaunched the run from that evidence as proof-B
(`campaign-20261107-225538-1478726`) with the 300 s default. Job
`r001-j0003` logged repeated `Machine-count capacity admission denied` and
then `❌ capacity admission remained blocked for 300s`. The native fixed-total
infra stop fired at 1/9.

## Diagnosis

Critical path: operator shell env → `scripts/run-bench --durable` (filters
names, forwards them with `systemd-run --setenv`) → unit re-executes
`scripts/run-bench` → ordinary campaign route `exec run-bench-campaign.py` →
`main()` writes `summary.json` and prints the launch banner → per-job fleet
controllers read `CLOUDBENCH_*` from their inherited environment.

The settings were correct in the unit environment and reached the
controllers, since epoch20 used 3600 s. They were first lost at the launch
record. `main()` builds `state` from argv-derived fields only and never
records the environment knobs that change admission and lifecycle behavior.
Why that could happen: the CLI had no contract for capturing launch
environment as evidence. Before `--durable`, the settings lived only in the
operator's shell history. `--durable` put them in a unit `Environment=` that
is garbage-collected and not part of the campaign directory. The only
copy-out filter was the forwarder's inline `case` pattern.

Reproduction: the ordinary CLI route (real `scripts/run-bench` exec'ing the
real campaign `main()` for a scratch `--root`, an expired original clock so no
controller is admitted, a recording fake `flyctl` on PATH/HOME) with the
three epoch20 settings plus secret-shaped decoys. Pre-fix:
`cd agents && python -m pytest -q benchmarks/cloudbench_campaign_inventory_test.py -k records_nonsecret_operator_settings_at_launch`
failed with `assert None == {'CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS': '3600', ...}`
(`summary.get('operator_settings')` was `None`).

## Solution

`scripts/run-bench` now has one secret-like name filter,
`run_bench_secret_like_name`. The durable `--setenv` forwarder and a new
step just before the ordinary campaign `exec` both use it. That step exports
`RUN_BENCH_OPERATOR_SETTING_NAMES`, the exported non-secret `CLOUDBENCH_*`
names. The filter also treats `*_B64` names as secret-like now, because
base64 env payloads are this repo's credential transport form.
`run-bench-campaign.py` `launch_operator_settings()` records those names
and values as `summary.json` `operator_settings` in the first launch write.
The banner prints them as `operator settings: NAME=value ...`. It prints
`none set (source defaults)` when there are none, and `UNRECORDED (launched
without scripts/run-bench)` for a direct launch. The campaign never
classifies secrets itself.

This also covers the non-durable launches in that class: setsid, plain
foreground and Hub-dispatched `scripts/run-bench` campaigns. At 10k agents
the cost is one environment scan and one small dict per campaign launch, with
no per-agent work. Post-fix, the same command passed. It also passed five
consecutive runs and the full `campaign_inventory` selection of the
benchmark-live-results structural gate.

## Human feedback

None recorded.

## Reusable lesson

When a launcher carries behavior-changing environment into a detached
controller, record those settings in the run's own launch evidence and banner
through the launcher's one secret filter. Never leave the service environment
as their only record.
