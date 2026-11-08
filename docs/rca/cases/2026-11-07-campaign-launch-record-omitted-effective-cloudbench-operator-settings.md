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
  - commit 4e378a35fa (first fix; review CHANGES_REQUIRED)
  - commit 658daf10d0 (second fix; round-2 review CHANGES_REQUIRED)
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py::test_campaign_inventory_normal_cli_records_nonsecret_operator_settings_at_launch (+ test_campaign_inventory_operator_settings_python_filter_matches_run_bench, scripts/tests/run-bench-durable-service.test.py)
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

`scripts/run-bench` has one secret-like filter, `run_bench_secret_like_setting
NAME VALUE`. The durable `--setenv` forwarder uses it; its `Environment=` is
readable via `systemctl show` and its log receives the banner. A new step
just before the ordinary campaign `exec` uses it too, exporting
`RUN_BENCH_OPERATOR_SETTING_NAMES` (the exported non-secret `CLOUDBENCH_*`
names). The filter withholds three kinds of setting:

- names containing TOKEN, SECRET, PASSWORD, PASSWD, API_KEY, AUTH_HEADER,
  AUTHORIZATION, COOKIE, CREDENTIAL, PRIVATE, OTP or SIGNATURE;
- names ending in `_KEY`, `_B64`, `_AUTH`, `_DSN`, `_PAT`, `_PASS`, `_PWD`,
  `_JWT` or a card field (`_PAN`, `_CVV`, `_CVC`, `_PIN`, `_EXPIRY`);
- any value with URL userinfo (`://[^/]*@` or `://[^/]*:[^@]*@`), or
  containing `Bearer `, `FlyV1 `, `-----BEGIN`, `ghp_`, `github_pat_` or
  `X-Amz-Signature`.

The function sets `LC_ALL=C`, so invalid UTF-8 matches byte-wise exactly as
Python's surrogateescape strings do. A plain switch value is never withheld.
Like `_benchmark_env_bool`, it is matched ASCII case-insensitively after
trimming whitespace: `''`, 0/1, true/false, yes/no, on/off. That way flags
such as `BENCHMARK_DISABLE_SAVED_BROWSER_AUTH=true`,
`BENCHMARK_MINTED_PREFER_PHONE_AUTH=YES` and `BENCHMARK_ALLOW_DEV_OTP_LOGIN=1`
still forward. There is deliberately no
bare `*AUTH*`: `*_AUTHORITY` names and the `CLOUDBENCH_CODEX_AUTH_*` helper
settings are ordinary settings.

`run-bench-campaign.py` `launch_operator_settings()` treats the name list as
untrusted. It re-applies the same filter as `secret_like_setting()`, and a
parity regression runs both implementations over the same cases. It records
the survivors as `summary.json` `operator_settings` in the first launch
write. Values over 1024 characters keep their prefix plus a
`…[truncated: 1024 of N characters recorded; sha256=…]` marker. The banner
prints `operator settings: NAME=value ...` with control characters escaped,
so a value cannot forge a banner line or a terminal escape. It prints `none
set (source defaults)` when there are none, and `UNRECORDED (launched
without scripts/run-bench)` for a direct launch.

The adversarial review (CHANGES_REQUIRED on commit 4e378a35fa) showed that
the first name-only filter recorded `CLOUDBENCH_WIRE_AUTH` (Fly API
Authorization) and `CLOUDBENCH_FETCHABLE_AUTH_HEADER` (GitHub Basic header)
values. It also left the pre-existing durable forwarding of
`ROSE_AGENT_CARD_*` and credentialed `BENCHMARK_*_DATABASE_URL` values
uncovered. Traced consumers: card fields are read only by the backend from
its env file. The `*_SOURCE_DATABASE_URL` values are set by `run_benchmark.py`
for its own children. `CLOUDBENCH_WIRE_AUTH`/`_FETCHABLE_AUTH_HEADER` are
set inline for single child processes. None needs operator-environment
forwarding.

This also covers the non-durable launches in that class: setsid, plain
foreground and Hub-dispatched `scripts/run-bench` campaigns. At 10k agents
the cost is one environment scan and one small dict per campaign launch, with
no per-agent work.

## Human feedback

Round-2 review (CHANGES_REQUIRED on commit 658daf10d0) found that the
switch exemption was case-sensitive. `=YES`/`=On` on `*_AUTH` switches was
withheld under `--durable`, although `_benchmark_env_bool` accepts it. It
required a case-insensitive, trimmed match, `LC_ALL=C` for invalid-UTF-8
parity and `\Z` anchors. It also suggested the optional
`_PASS`/`_PWD`/`_JWT`/`SIGNATURE` names and the credential-shaped value
patterns.

Adversarial review (descend coordinator, I-31) rejected the name-only filter
as leaking credential-carrying names and URL userinfo. It required the same
filter to be re-applied in Python, a value cap and banner control-character
escaping. It required card and credentialed-URL values to be excluded from
durable forwarding, and forbade a bare `*AUTH*` pattern because it would stop
forwarding `*_AUTHORITY` and `CLOUDBENCH_CODEX_AUTH_*` settings.

## Reusable lesson

When a launcher carries behavior-changing environment into a detached
controller, record those settings in the run's own launch evidence and banner
through the launcher's one name-and-value secret filter. Never leave the service environment
as their only record.
