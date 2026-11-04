# Factory telemetry standard

Every new `/deploy`, `/RCA`, `/update-prompts`, `/descend` and factory timing record must
retain execution context alongside timestamps. `scripts/factory_metadata.py`
defines the versioned allowlist; the writer supplies explicit `null` for unknown
fields. Zero means a measured zero, never unavailable data.

## Recording

Create an ignored `.context/factory-metadata.json` with `schema_version: 1`,
`observed_at` (timezone-aware ISO timestamp), `record_type: "snapshot"`, the
sections below, and an `evidence` object mapping every non-null field path to its
source reference. Export `FACTORY_METADATA_FILE` to its absolute path before
starting a run. The stage runner captures this file **before executing** the
command. Events also accept `--metadata-file PATH`. Invalid selected metadata
fails collection; absent metadata produces explicit unknowns, not guessed defaults.

Example (replace values only from actual harness receipts):

```json
{
  "schema_version": 1,
  "observed_at": "2026-10-28T02:35:09.953Z",
  "execution": {"model": "gpt-6.1-sol", "reasoning_effort": "medium"},
  "evidence": {
    "execution.model": "sanitized harness turn_context receipt",
    "execution.reasoning_effort": "sanitized harness turn_context receipt"
  }
}
```

- **execution:** provider, exact model ID, reasoning effort, service tier, harness
  and harness version. Service tier means configured speed/priority; measured
  throughput belongs in timing. Model branding does not prove provider routing,
  effort, tier or version. Re-read actual harness/turn settings when available.
- **usage:** input tokens **including cached input**, output tokens, cached input
  subset, cost in USD. State scope with attribution. Use authoritative counters
  with an assignment baseline; never estimate tokens from text, wall time or
  credits. Do not double-count cache or reasoning already included in output.
  Convert provider-specific counter definitions explicitly before recording.
  Preserve counter resets and unknown costs; subscription use is not free.
- **attribution:** run, assignment, thread, agent, parent agent and configuration
  IDs. These identify scope; do not attribute all workers to the parent model.
- **timing:** active, approval/queue/rate-limit/infrastructure waits and other
  seconds; measured TTFT seconds and output tokens/sec when available. Timing
  categories are disjoint unions within one scope; parallel lane sums overlap.
  Preserve original clocks and all attempts. Never sum cumulative snapshots.
- **environment:** OS, architecture, runtime version, resource class and actual
  concurrency. Do not infer allocated capacity from a plan or configuration cap.
- **validation:** exact source SHA, redacted command, actual result and durable
  evidence reference. A reference is not proof of a pass by itself.

For configuration/model changes and usage measurements, append a new
`metadata snapshot` event with its actual observation timestamp and scope:

```bash
python3 scripts/record_factory_event.py deploy metadata snapshot --metadata-file .context/factory-metadata.json
python3 scripts/factory_ledger.py publish
```

Emit snapshots at assignment start/end and configuration changes. New stages
read the refreshed file; snapshots do not rewrite older stages. `bash
scripts/run-deploy-stage --start` and every `run_deploy_pipeline.py run` attempt
re-stamp the selected snapshot's `observed_at` and `validation.source_sha` (with
its evidence) from `git rev-parse HEAD` when the file lives inside that checkout;
nothing else is rewritten, and an invalid snapshot refuses the run. Final reports
must show recorded model/effort/tier (or UNKNOWN), usage scope and collection gaps.
Do not claim the ledger alone collected these settings automatically.

## Work and wait intervals

All agents follow **Work versus waiting** in
`.claude/shared/report-display-format.md`. Record actual work and wait
transitions with `record_factory_event.py` using `work-start`/`work-finish` or
`wait-start`/`wait-finish`, a stable `request_id`, the original `run_id`, and a
nonsecret `reason` in `--detail`. Close a work interval before waiting; give
independent parallel activity its own ID. Use native stage receipts for running
automation rather than labeling a whole test duration as agent effort.

`deploy_timeline.event_intervals` pairs matching native records;
`deploy_timeline.account` computes disjoint wall totals while preserving
overlapping lane evidence. Missing historical intervals count only in the
**Wait — reason unrecorded** reporting bucket. That bucket proves neither a
specific external cause nor active work. Do not retroactively manufacture
activity or label an unknown gap as an out-of-credits/user delay.

## Backfill, publication and privacy

Historical enrichment is **append-only**: set `record_type: "retrospective"`,
retain the original observation time, run ID, source/hash and limitations in a
sanitized evidence receipt. Leave unproven values null. Never overwrite original
outcomes, failed attempts, durations or rows already on main. A later waiver or
completion is a new outcome event, not a rewrite of the earlier blocked event.
The publisher preserves telemetry on events/stages and remains idempotent.
Legacy records remain readable; missing legacy telemetry means unrecorded.

Publish the allowlisted metadata and sanitized receipts, **never** raw harness
transcripts, credentials, API keys, environment dumps, customer data, signed
URLs, authentication headers or unredacted commands. Check references and text
manually for secrets before publishing; schema validation cannot recognize all
secrets in allowed text. Keep raw evidence local with restricted access.

`/factory-review` comparisons must stratify by recorded model/effort/tier,
harness/version, resource class, concurrency, source and validation scope where
possible; show sample sizes and unknown cohorts. Distinguish coding-agent
settings from benchmark agents and deployed services. Timing differences alone
do not establish that a model or effort caused the difference.
