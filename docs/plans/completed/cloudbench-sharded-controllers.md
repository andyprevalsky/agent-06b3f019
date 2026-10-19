# Sharded benchmark controllers

## Goal

One wide campaign (e.g. 200 tasks × k3 = 600 copies) runs across K disposable
controller VMs instead of one. The CLI picks K from how many copies one
controller handles easily, releases every shard's tasks together through one
global strict barrier, and reports one combined result. K = 1 keeps today's
single-controller behaviour byte-for-byte.

Why: the single performance-8x controller ran out of memory and CPU at 600
copies (flyctl OOM in #57, campaign-parent OOM in #72, load 1,146 on 8 vCPU)
and no original600 run ever released its barrier. Width ~50 has executed
reliably.

## System context

```
operator host: run-original600-controller.py --run --controllers auto
 |-- plan_shards(tasks, k, profile) -> K shards (all k copies of a task stay on one shard)
 |-- one fresh capacity admission: N primaries + K controllers + 2K canary + W workers
 |-- Hub group register (N members, one group id, one start epoch)
 |-- spawn K runner processes (cloudbench-original600-runner.py --config ... --output ...)
 |        runner_i -> run-cloudbench-controller-gate -> disposable controller_i
 |                                   controller_i: supervisor -> run-bench campaign (shard_i, --strict-barrier)
 |                                                 -> C*k fleets -> guests
 |-- coordinate():
 |     read each runner's out/shard-status.json (barrier ready.json + infra counts via PROBE)
 |     all K shards ready -> write out/global-release.json in every runner dir
 |        runner_i -> exec RELEASE -> controller_i barrier/release.json -> cohort release
 |     any shard failed before release -> global-abort.json -> exec ABORT
 |     global infra >= threshold (when enabled) -> SIGTERM all runners (existing TERM path)
 |-- join K runners (each owns export + cleanup of its own controller)
 '-- merge shard summaries -> combined summary.json, Hub group final
```

## Interface contract (all lanes build against this)

### Runner config: optional `shard` object

Absent `shard` = legacy single run, unchanged argv/env/checks.

```json
"shard": {
  "index": 0, "count": 20,
  "tasks": ["task-a", "task-b"],
  "tasks_sha256": "<sha256 of '\\n'.join(tasks)+'\\n'>",
  "task_indexes": [0, 20],
  "runs": 3,
  "group_run_id": "<shared group id>",
  "group_total": 600,
  "group_started_at": 1792287011.18
}
```

`tasks` must be an ordered subset of the pinned original 200-name manifest
(`tasks_path`, TASK_NAMES_SHA unchanged); `task_indexes[k]` is the manifest index of `tasks[k]`. Shard concurrency = len(tasks) × runs.

### Campaign environment (run-bench-campaign.py)

| Variable | Meaning |
| --- | --- |
| `RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER=<abs dir>` | Strict single-cohort campaigns only. Cohort readiness is published to `<dir>/ready.json`; release waits for `<dir>/release.json`; `<dir>/abort.json` aborts the cohort. |
| `RUN_BENCH_CAMPAIGN_TASK_INDEXES=i0,i1,...` | Global manifest index per `--task`; job IDs become `r{run:03d}-j{global_index:04d}`, identical to a single-controller run, so existing job-ID validators are unchanged and IDs are unique across shards. |
| `RUN_BENCH_CAMPAIGN_GROUP_TOTAL=<N>` | Children publish `group_total=N` instead of the shard's job count. |
| `BENCHMARK_HUB_GROUP_RUN_ID=<id>` | Existing: preset group; the shard does not publish its own group record. |
| `RUN_BENCH_CAMPAIGN_GROUP_STARTED_AT=<epoch>` | Group timestamp shared by all shards. |

### External barrier files (in `RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER`)

- `ready.json` (campaign writes, atomic replace on change):
  `{"schema":"campaign-external-barrier-ready-v1","cohort_id":"c001","status":"waiting|ready|failed|aborted|released","ready_count":n,"failed_count":n,"expected_count":n,"survivor_count":n,"updated_at":"<iso>"}`.
  `status=ready` means every surviving member is ready and the cohort is waiting only for the external release.
- `release.json` (coordinator via runner exec, O_EXCL; same `release_id` = idempotent success):
  `{"schema":"campaign-external-barrier-release-v1","release_id":"<hex>","released_at":"<iso>"}`.
- `abort.json` (same rules): `{"schema":"campaign-external-barrier-abort-v1","release_id":"<hex>","reason":"<text>"}`.

Existing per-fleet barrier timeouts are unchanged: a late global release fails
each fleet strictly at its own deadline.

### Controller-side paths

Barrier dir on the controller: `/tmp/gate/repo/.context/<identity_stem>.barrier/`
where `<identity_stem>` is the supervisor identity filename without `.json`.
`REMOTE_LAUNCH` creates it (0700). Supervisor writes
`/tmp/gate/repo/.context/<identity_stem>.infra.json` each loop:
`{"schema":"original600-shard-infra-v1","infra_true":n,"unique_jobs":n,"observed_at":<epoch>}`.

### Runner exec actions (REMOTE_CONTROL)

- `PROBE` result gains `barrier` (parsed `ready.json` or null) and `infra` (parsed infra.json or null).
- `RELEASE` / `ABORT` payload adds `release_id`, `reason`; writes the barrier file; ACK states `RELEASED` / `ABORTED`.

### Runner ↔ coordinator files (runner `--output` dir)

- Runner writes `shard-status.json` atomically after each probe:
  `{"schema":"original600-shard-status-v1","state":"<probe state>","barrier":{...}|null,"infra":{...}|null,"observed_at":<epoch>,"machine":"<id>|null"}`.
- Coordinator writes `global-release.json` or `global-abort.json` (`{"release_id","reason"}`).
  Runner delivers it on its next loop (≤0.25 s), retrying the idempotent exec until ACK or supervisor JOINED;
  records `global-release.ack.json` / `global-abort.ack.json`.

### Shard planning (operator)

`copy_bound(profile) = min(4 × vCPU, (memory_MiB − 4096) // 700, 40)`; performance-8x/32 GB → 32 copies.
`tasks_per_controller = max(1, copy_bound // runs)`; `K = ceil(T / tasks_per_controller)`, shard sizes balanced to ±1.
Flags: `--controllers auto|K`, `--tasks-per-controller C`. K = 1 reproduces today's config exactly.
`--tasks` may name any ordered manifest of distinct tasks that are ready, cloud-root and LIVE eligible in the
unified catalog at the runner's `TASK_REF` (`fleet_infra_sample.eligible_pool`, checked locally before any
provider read). A non-original manifest runs only fresh sharded controllers; each shard binds its
`manifest_sha256`, which the runner and guest supervisor check instead of the original 200-task pin.
`--task-timeout S` (default 1200, 60..3300) and `--e2e-timeout S` (default 5400; at least S + 2100 startup/release,
at most the 5400-second operator deadline) become the campaign's `--timeout`/`--e2e-timeout` and are bound as
shard `task_timeout`/`e2e_timeout` only when they differ from the defaults, so original-manifest shards keep
their historical bytes. Archived reuse and continuations remain original-200, default-timeout only.

## Verification (automated)

- `scripts/tests/cloudbench-cleanup-ticket-campaign.test.py`: external barrier holds release until `release.json`; abort interrupts; deadline still fails; prefix/total/group env.
- `scripts/tests/campaign-hub-grouping.test.sh`: K shards publish into one N-member group; mismatched total rejected.
- `scripts/tests/cloudbench-original600-supervisor.test.py`: shard-parameterized validation, `infra.json`.
- Runner self-test: RELEASE/ABORT idempotence through REMOTE_CONTROL; shard-status emission; global file delivery.
- `scripts/tests/original600-portable-operator.test.py`: plan_shards; global capacity inequality; coordinator with fake runners (release only after all K ready, abort on early shard failure, TERM fan-out, join all K, merge).
- `scripts/tests/cloudbench-disposable-controller.test.py`: `sibling_controller_slots` admission.
- Live ladder (diagnostic, not acceptance): 100 → 300 copies through the same CLI, then the 600.
