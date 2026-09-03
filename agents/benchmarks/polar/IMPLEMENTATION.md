# Polar-bench implementation list

How Odysseys + BU Bench V1 were integrated as `polar-bench` (300 tasks).
Use with skill `.claude/skills/impl-bench/SKILL.md` for the next suite.

## Decisions (ordered)

1. **Vendor, don't rewrite** — sources live under `agents/benchmarks/polar/`
   (`odysseys.json` ×200, `bu_bench_v1.json` ×100). Prompts/rubrics kept faithful.
2. **Stable names** — `polar-odysseys-<id12>`, `polar-bu-NNN`. Names are history PKs; never rename.
3. **Group / tag** — every task has `group: "polar-bench"` and tag `polar-bench`.
   `bench: "rose-bench"` but **opt-in only** (`--suite polar-bench`). Excluded from
   `--suite all`, default daily fleet, and bare `browser` tag selection.
4. **Catalog codegen** — `polar_catalog.py` → committed `polar_tasks.json`.
   `long_horizon.validate_catalog()` merges the slice; tests freeze sync + exclusion.
5. **Isolated evaluator `method: "polar"`** — new module `polar_evaluator.py` mirrors
   Odysseys per-rubric full-trajectory grading:
   - one multimodal LLM call per rubric (task + one rubric + full action history + all screenshots)
   - `Thoughts:` / `Status: "success"|"failure"`
   - perfect-score only (`pass_threshold: 1.0`)
   - isolation contract: no `check_progress` / semantic-evidence / ecommerce judge imports;
     sole production call site is the lazy `method == "polar"` branch in `run_benchmark.py`
6. **BU rubrics** — BU has criteria (+ optional ground truth), not Odysseys rubrics;
   `parse_polar_rubrics` synthesizes `{id, requirement, verification}` so both suites
   share one judge loop. Ground truth stays in evaluator criteria, never the prompt.
7. **API / FE** — back-end blackbox zod allows `method: "polar"` + optional `rubrics`;
   Hub `TasksPane` `GROUPS` includes `polar-bench` for filterable UI.
8. **Verification** — unit tests for judge isolation + catalog; UI screenshots with
   `polar-bench` filter; full suite run to pass/fail (not queued).
9. **Write-lock off for polar** — `approval_handling=None` (not `ignore`/`auto_approve`,
   which require a gate). `create_agent` therefore sets `write_lock_enabled=false` for
   polar tasks so Google-search / form submits do not pause agents forever. Override
   with `BENCHMARK_WRITE_LOCK_ENABLED=true` only when intentionally testing locks.

## Key files

| Role | Path |
| --- | --- |
| Sources | `agents/benchmarks/polar/odysseys.json`, `bu_bench_v1.json` |
| Catalog builder | `agents/benchmarks/polar_catalog.py` |
| Catalog slice | `agents/benchmarks/polar_tasks.json` |
| Evaluator | `agents/benchmarks/polar_evaluator.py` |
| Dispatch | `agents/benchmarks/run_benchmark.py` (`method == "polar"`) |
| Method registry | `agents/benchmarks/long_horizon.py` |
| Tests | `polar_evaluator_test.py`, `polar_catalog_test.py` |
| FE filter | `front-end/src/features/benchmarks/TasksPane.tsx` |

## Commands

```bash
cd agents && source venv/bin/activate
python -c "from benchmarks.polar_catalog import write_polar_tasks_file; write_polar_tasks_file()"
python -m pytest benchmarks/polar_evaluator_test.py benchmarks/polar_catalog_test.py -q
# Prefer --local. Bare scripts/run-bench (no --local) spawns the paid Fly fleet.
# Cloud VMs with broken Docker overlay mounts: force system Postgres.
ROSE_USE_SYSTEM_PG=true scripts/run-bench --local --suite polar-bench --max-concurrency 8 --keep-services
```
