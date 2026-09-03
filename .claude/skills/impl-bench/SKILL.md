---
name: impl-bench
description: Integrate an external benchmark suite into Rose Labs (catalog, isolated evaluator, FE group filter, screenshots, full pass/fail run). Use when adding a new bench, porting an upstream eval, or when the user mentions impl-bench / benchmark integration.
---

# impl-bench — Benchmark Integration Skill

Reuse this checklist whenever you wire a new external benchmark into Rose Labs.
It was extracted from the **polar-bench** (Odysseys + BU Bench V1) integration.

## Non-negotiable acceptance gates

A bench integration is **not done** until all of these are true:

1. **Catalog** — every task is in the unified catalog with a stable `name`, `group`, and tag matching the bench id (e.g. `polar-bench`). Never rename an existing task `name` (history PK).
2. **Isolated evaluator** — if the upstream suite has its own grader, implement it as a **new** `evaluators[].method` in its own module. Do **not** overload `single_turn_llm_judge` / `agentic_llm_judge` / ecommerce prompts. Isolation = no imports of those paths; lazy dispatch only inside `method == "<yours>"`.
3. **FE filter** — Hub Tasks pane lists the new `group` and can filter to only that bench's tasks.
4. **UI screenshots** — capture the Benchmarks UI with the group/tag filter applied, showing the bench's tasks visible.
5. **Full run to terminal states** — run **all** ready tasks for that bench until every task is `passed` or `failed` (never left `queued` / `running`). Pass rate may be low; terminal outcomes are required.
6. **Documented implementation list** — leave a short how-we-built-it list next to the bench sources (see polar example below).

## Polar-bench reference map

| Piece | Path |
| --- | --- |
| Sources (vendored) | `agents/benchmarks/polar/odysseys.json`, `bu_bench_v1.json` |
| Catalog builder | `agents/benchmarks/polar_catalog.py` |
| Generated catalog slice | `agents/benchmarks/polar_tasks.json` (300 tasks) |
| Isolated evaluator | `agents/benchmarks/polar_evaluator.py` (`method: "polar"`) |
| Catalog merge / validation | `agents/benchmarks/long_horizon.py` (`EVALUATION_METHODS` includes `polar`) |
| Runtime dispatch | `agents/benchmarks/run_benchmark.py` → `method == "polar"` branch |
| Implementation notes | `agents/benchmarks/polar/IMPLEMENTATION.md` |
| FE group chip | `front-end/src/features/benchmarks/TasksPane.tsx` → `GROUPS` includes `polar-bench` |
| API zod | `back-end/src/tests/blackbox/benchmarks.blackbox.ts` evaluator `method` enum |

## Step-by-step playbook

### 1. Vendor sources, don't rewrite prompts

- Copy upstream task JSON into `agents/benchmarks/<bench>/`.
- Keep prompts / rubrics / ground-truth answers faithful.
- Ground-truth answers belong in **evaluators**, never in the agent `prompt`.

### 2. Build a catalog slice

- Emit tasks with:
  - `group: "<bench-id>"`, `tags: ["<bench-id>", ...]`
  - `bench: "rose-bench"` (or the correct axis) — polar stays opt-in and is **excluded** from `--suite all` / daily fleet
  - `status: "ready"`, `runner: "agent"`, `enforce_declared_evaluators: true`
- Commit a generated `*_tasks.json` and a `write_*_tasks_file()` rebuild path.
- Cement `test_*_tasks_file_matches_sources` so the committed file cannot drift.

### 3. Implement an isolated evaluator (when upstream has a grader)

Polar pattern (Odysseys-faithful):

- Per-rubric multimodal LLM call: task + **one** rubric + full action history + **all** screenshots.
- Response format `Thoughts:` / `Status: "success"|"failure"`.
- Task passes only on perfect score (`pass_threshold: 1.0`).
- Module docstring must state the **isolation contract** (forbidden imports + sole call site).
- Unit-test: mock LLM success/fail, trajectory screenshot collection, AST import isolation, lazy dispatch in `run_benchmark`.

Wire method into:

- `long_horizon.EVALUATION_METHODS` / `RUNTIME_EVALUATION_METHODS`
- polar-specific validation (e.g. require `rubrics[]`, do **not** require `judge_prompt`)
- `run_benchmark` declared-evaluator branch (lazy import)
- back-end blackbox zod enum (+ optional `rubrics`)

### 4. Suite selection / blast-radius

- `--suite <bench-id>` selects the slice.
- Default suites (`all`, `rose-bench`, bare `browser` tag) must **not** inherit the new flood.
- Add `is_<bench>_task()` helpers and tests proving exclusion + opt-in selection.

### 5. Frontend group filter

- Add the bench id to `GROUPS` in `TasksPane.tsx`.
- Confirm Hub catalog adapter surfaces `group` / tags (no FE/catalog drift).
- Capture screenshots: default view → filter by bench group → task list shows only that bench.

### 6. Full working run (pass/fail, not queued)

```bash
# Local isolated stack (preferred for cloud agents / cost control).
# Without --local, scripts/run-bench routes to the paid Fly fleet — do NOT
# fan out hundreds of live browser tasks onto fleet machines by accident.
scripts/run-bench --local --suite polar-bench --max-concurrency 5 --keep-services

# Or explicit names
scripts/run-bench --local polar-odysseys-440ed7f388a2 polar-bu-001
```

Requirements:

- Drive until every selected task reaches `passed` or `failed`.
- Do **not** stop while tasks remain `queued`/`running`.
- Do **not** raise timeouts to chase a pass (rule 25).
- Publish durable FE evidence for failures when needed (`scripts/publish_evidence_links.py`).
- Record the run under `agents/benchmarks/runs/` and history ledgers.

### 7. Document what you did

Update/create `agents/benchmarks/<bench>/IMPLEMENTATION.md` with the ordered list of decisions (sources, naming, evaluator isolation, suite exclusion, FE filter, verification commands). Keep it short and operational — future agents should be able to copy the pattern.

## Anti-patterns (do not)

- Reusing `single_turn_llm_judge` + ecommerce `check_progress` for a foreign grader.
- Putting the new bench on `group: "daily"` or letting `--suite all` fan it out.
- Renaming task `name`s after history exists.
- Raising benchmark timeouts / softening pass criteria to force green.
- Shipping without FE screenshots + a full terminal-state run.
- Top-level importing the new evaluator from `run_benchmark` (breaks isolation).

## Verification commands (polar)

```bash
cd agents && source venv/bin/activate
python -m pytest benchmarks/polar_evaluator_test.py benchmarks/polar_catalog_test.py -q
python -c "from benchmarks.polar_catalog import build_polar_catalog_tasks; t=build_polar_catalog_tasks(); assert all(e['method']=='polar' for x in t for e in x['evaluators'])"
scripts/run-bench --local --suite polar-bench --max-concurrency 5 --keep-services
```

Then open the Hub Benchmarks UI, click the `polar-bench` group chip, screenshot.
