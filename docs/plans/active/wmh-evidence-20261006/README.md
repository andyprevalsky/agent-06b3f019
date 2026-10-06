# Portable WMH evidence for the local continuation

These files came from the cloud `porto-novo` worktree on 2026-10-06 and are
included on the branch so a separate local worktree can inspect the exact
benchmark runs and build reports. The `.json.gz` files are gzip-compressed JSON;
run `gzip -dc <file>` to read them. Do not treat the older inference report as
validation of the September 28 artifact or a new build.

| File | Source | Purpose |
| --- | --- | --- |
| `latest-30m-run.json.gz` | `agents/benchmarks/runs/20260929_024443_raise-5m-rose-labs-brex.json` | Exact 22m27s failed diagnostic, root `89cb4dfb-551e-4dd5-a92c-94182274ef77` |
| `previous-10m-run.json.gz` | `agents/benchmarks/runs/20260928_213636_raise-5m-rose-labs-brex.json` | Earlier 600-second timeout trajectory |
| `corpus-conformance.json.gz` | `.context/world-model/conformance.json` | September 28 corpus coverage and 100 sampled cases |
| `corpus-delta-index.json.gz` | `.context/world-model/delta-index.json` | September 29 indexed root provenance/verdicts |
| `corpus-audit-14d.json`, `corpus-audit-30d.json` | `.context/wmh-final-audit-schema10-*.json` | Prior archive screening waterfall |
| `older-prediction-conformance.json.gz` | `.context/wmh-prediction-conformance.schema10.json` | September 12 inference score; historical comparison only |
| `build.manifest.json`, `model-config.toml`, `model-*.snapshot`, `model-metrics.json` | `.context/world-model/` | Small metadata and prompt snapshots from the local `rose-archive` build |

To put the two run records at their usual ignored paths for existing analysis
scripts, from the repository root:

```bash
mkdir -p agents/benchmarks/runs
gzip -dc docs/plans/active/wmh-evidence-20261006/latest-30m-run.json.gz \
  > agents/benchmarks/runs/20260929_024443_raise-5m-rose-labs-brex.json
gzip -dc docs/plans/active/wmh-evidence-20261006/previous-10m-run.json.gz \
  > agents/benchmarks/runs/20260928_213636_raise-5m-rose-labs-brex.json
```

The generated model index (`embeddings.npy` and `steps.jsonl`) is roughly
1.5 GB and the raw OTel trace file is roughly 1.5 GB. They are reproducible
build outputs and are not Git files. This branch includes their source code,
build metadata, corpus audit, and exact diagnostic run records. Rebuild the
model from the complete eligible R2 archive using the repo setup and credentials:

```bash
cd agents
WMH_BUILD_DIR="$PWD/../.context/world-model" \
WMH_MODEL_NAME=rose-r2-archive-anthropic \
WMH_GEPA_BUDGET=0 WMH_MAX_BUNDLES=0 WMH_MAX_STEPS=0 \
WMH_MAX_STEPS_PER_BUNDLE=0 WMH_CONFORMANCE_EXAMPLES=100 \
WMH_REQUIRE_CONFORMANCE=1 \
  ./venv/bin/python -c 'from benchmarks.world_model_harness import update_world_model_for_simulation as build; print(build())'
```

The build needs the R2 credentials configured per `CLAUDE.md`. A cloud-bench
refresh can instead use `bash scripts/run-bench-cloud --refresh-wmh --ref
<pushed-commit>`; that path fetches only committed code. After building, serve
the matching model and run `benchmarks.run_world_model_conformance` as directed
in `agents/benchmarks/README.md`. The 100-call inference gate must pass on the
new build before the fundraiser simulation result is interpreted as model
quality evidence.
