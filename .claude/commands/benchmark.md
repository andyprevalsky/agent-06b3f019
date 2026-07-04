---
description: "Run local benchmark/eval tasks through the isolated benchmark entrypoint."
argument-hint: "list | eval [--bench rose-bench|pipeline-e2e] [--agent-only] [--only a,b] | <task-name...> [--full] [--rerun-failed latest]"
---

# Benchmark Runner

Use the repository entrypoint for all local benchmark and eval runs:

```bash
scripts/run-bench $ARGUMENTS
```

Behavior:

- `scripts/run-bench list` prints the benchmark catalog.
- `scripts/run-bench <task-name...>` runs benchmark tasks via `agents/benchmarks/local.py`.
- `scripts/run-bench eval ...` runs `agents/benchmarks/run_eval_suite.py` via the same isolated local stack.

The entrypoint owns local service startup and teardown, per-run ports, per-run
Postgres container/volume naming through `CONDUCTOR_WORKSPACE_NAME`, frontend
and public tunnel URLs, Temporal task queue naming, non-load benchmark
concurrency, load-test serialization, payment fixture setup, failed-agent
retention, and local diagnostics.

Do not start `scripts/run.sh` manually for local benchmark work unless the user
explicitly asks for a shared existing stack. Use `--use-existing` only when
services are already running and the user wants to reuse `.context/services.json`.
