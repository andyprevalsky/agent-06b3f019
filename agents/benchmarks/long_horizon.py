"""Unified eval-catalog validation + long-horizon idea bank.

System context:

    agents/benchmarks/tasks.json  <-- THE single canonical eval catalog
            |                          (BenchmarkTask + additive eval contract:
            |                           status, runner, environment, evaluators, source)
            v
    long_horizon.py validate_catalog()   long_horizon_ideas.json (idea bank)
            |                                     |
            v                                     v
    run_eval_suite.py / run_benchmark.py    future /eval-from-trace promotions

The catalog is data-first: `run_benchmark.py` executes benchmark-agent entries
today via its built-in evaluation (expected tools, receipts, approvals), while
`evaluators[]` declares the target contract for the judge harness. `status`
tracks whether an entry is runnable end-to-end (`ready`) or still missing
fixtures/services/judges (`incomplete`).

Hard constraint: task `name` is the primary key across the history stores
(`history/task_durations.jsonl` success ledger, `history/span_durations.jsonl`
p99 baselines, `runs/*.json` records). Existing names must never be renamed —
renames orphan pass history and latency baselines.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from benchmarks.live_fixtures import LIVE_FIXTURE_NAMES

CATALOG_VERSION = "0.1"
EVALUATION_METHODS = {"static_check", "single_turn_llm_judge", "agentic_llm_judge"}
ENVIRONMENT_MODES = {"synthetic", "live", "hybrid"}
# "retired" = kept for ledger/history integrity (names are cross-store primary
# keys) but hidden from every surface: eval suite, hub catalog, query-box picker.
TASK_STATUSES = {"ready", "incomplete", "retired"}
TASK_RUNNERS = {"agent"}
# pipeline-e2e = e2e test that a harness pipe/quirk works (write locks trigger,
# cookies inject, tool plumbing). rose-bench = harness-INDEPENDENT capability
# measurement: fixture + prompt + evaluators are portable to any harness
# (swap in Claude Code, measure whether/how fast it succeeds).
TASK_BENCHES = {"pipeline-e2e", "rose-bench"}
# Per-bench world-model (sim) toggle. Absent = "real" (sim OFF) by default; the
# cloud runner exports this per isolated machine so each bench runs in its own mode.
WORLD_MODEL_MODES = {"real", "simulate", "shadow"}
IDEA_STATUSES = {"idea", "promoted", "rejected"}

_HERE = Path(__file__).resolve().parent
DEFAULT_CATALOG = _HERE / "tasks.json"
DEFAULT_IDEA_BANK = _HERE / "long_horizon_ideas.json"


@dataclass(frozen=True)
class LongHorizonIdea:
    id: str
    title: str
    raw_user_idea: str
    normalized_goal: str
    status: str
    likely_environment_modes: list[str]
    likely_evaluation_methods: list[str]
    safety_notes: str


def _require_non_empty_string(raw: dict[str, Any], field: str, item_id: str) -> str:
    value = raw.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{item_id}: {field} must be a non-empty string")
    return value


def _require_string_list(raw: dict[str, Any], field: str, item_id: str, *, allow_empty: bool = False) -> list[str]:
    value = raw.get(field)
    if not isinstance(value, list) or (not allow_empty and not value):
        raise ValueError(f"{item_id}: {field} must be a {'possibly empty ' if allow_empty else ''}list")
    if not all(isinstance(v, str) and v.strip() for v in value):
        raise ValueError(f"{item_id}: {field} must contain only non-empty strings")
    return value


def _validate_environment(env: dict[str, Any], item_id: str) -> dict[str, Any]:
    if not isinstance(env, dict):
        raise ValueError(f"{item_id}: environment must be an object")
    mode = env.get("mode")
    if mode not in ENVIRONMENT_MODES:
        raise ValueError(f"{item_id}: environment.mode must be one of {sorted(ENVIRONMENT_MODES)}")
    for field in ("db_fixtures", "base_images", "services", "secrets", "live_targets"):
        _require_string_list(env, field, item_id, allow_empty=True)
    if not isinstance(env.get("context_notes"), str) or not env["context_notes"].strip():
        raise ValueError(f"{item_id}: environment.context_notes must be a non-empty string")
    if mode == "live" and env.get("db_fixtures"):
        raise ValueError(f"{item_id}: live evals must not declare db_fixtures")
    # live_fixtures is optional in the raw catalog (tasks omitting it inherit
    # ["base"] at load time); validate only when explicitly declared.
    live_fixtures = env.get("live_fixtures")
    if live_fixtures is not None:
        _require_string_list(env, "live_fixtures", item_id, allow_empty=True)
        unknown = [f for f in live_fixtures if f not in LIVE_FIXTURE_NAMES]
        if unknown:
            raise ValueError(
                f"{item_id}: unknown live_fixtures {unknown}; "
                f"known: {sorted(LIVE_FIXTURE_NAMES)}"
            )
        if mode == "synthetic" and live_fixtures:
            raise ValueError(
                f"{item_id}: synthetic evals must not declare live_fixtures "
                f"(live credentials have no meaning for a fully synthetic task)"
            )
    return env


def _validate_evaluator(evaluator: dict[str, Any], item_id: str, index: int) -> dict[str, Any]:
    if not isinstance(evaluator, dict):
        raise ValueError(f"{item_id}: evaluators[{index}] must be an object")
    evaluator_id = evaluator.get("id")
    if not isinstance(evaluator_id, str) or not evaluator_id.strip():
        raise ValueError(f"{item_id}: evaluators[{index}].id must be a non-empty string")
    method = evaluator.get("method")
    if method not in EVALUATION_METHODS:
        raise ValueError(f"{item_id}: evaluators[{index}].method must be one of {sorted(EVALUATION_METHODS)}")
    criteria = evaluator.get("criteria")
    if not isinstance(criteria, list) or not criteria:
        raise ValueError(f"{item_id}: evaluators[{index}].criteria must be a non-empty list")
    if not all(isinstance(c, str) and c.strip() for c in criteria):
        raise ValueError(f"{item_id}: evaluators[{index}].criteria must contain only non-empty strings")
    if method == "static_check":
        checks = evaluator.get("checks")
        if not isinstance(checks, list) or not checks:
            raise ValueError(f"{item_id}: static_check evaluators must include non-empty checks")
        for check_index, check in enumerate(checks):
            if not isinstance(check, dict):
                raise ValueError(f"{item_id}: evaluators[{index}].checks[{check_index}] must be an object")
            check_type = check.get("type")
            if not isinstance(check_type, str) or not check_type.strip():
                raise ValueError(f"{item_id}: evaluators[{index}].checks[{check_index}].type must be a string")
    if method in {"single_turn_llm_judge", "agentic_llm_judge"} and not evaluator.get("judge_prompt"):
        raise ValueError(f"{item_id}: LLM judges must include judge_prompt")
    return evaluator


def _validate_evaluators(evaluators: list[Any], item_id: str) -> list[dict[str, Any]]:
    if not isinstance(evaluators, list) or not evaluators:
        raise ValueError(f"{item_id}: evaluators must be a non-empty list")
    parsed = [_validate_evaluator(evaluator, item_id, i) for i, evaluator in enumerate(evaluators)]
    ids = [evaluator["id"] for evaluator in parsed]
    if len(ids) != len(set(ids)):
        raise ValueError(f"{item_id}: evaluator ids must be unique")
    return parsed


def validate_task_contract(raw: dict[str, Any]) -> None:
    """Validate one tasks.json entry's eval-contract fields (all additive/optional).

    Base BenchmarkTask fields are enforced by the dataclass loader in
    benchmark_tasks.py; this validates the unified-catalog extensions.
    """
    item_id = _require_non_empty_string(raw, "name", "<task>")
    status = raw.get("status", "ready")
    if status not in TASK_STATUSES:
        raise ValueError(f"{item_id}: status must be one of {sorted(TASK_STATUSES)}")
    runner = raw.get("runner", "agent")
    if runner not in TASK_RUNNERS:
        raise ValueError(f"{item_id}: runner must be one of {sorted(TASK_RUNNERS)}")
    if raw.get("bench") not in TASK_BENCHES:
        raise ValueError(f"{item_id}: bench must be declared explicitly, one of {sorted(TASK_BENCHES)}")
    world_model_mode = raw.get("world_model_mode")
    if world_model_mode is not None and world_model_mode not in WORLD_MODEL_MODES:
        raise ValueError(f"{item_id}: world_model_mode must be one of {sorted(WORLD_MODEL_MODES)}")
    description = raw.get("description")
    if description is not None and (not isinstance(description, str) or not description.strip()):
        raise ValueError(f"{item_id}: description must be a non-empty string when present")
    source = raw.get("source")
    if source is not None:
        _require_string_list(raw, "source", item_id)
    environment = raw.get("environment")
    if environment is not None:
        _validate_environment(environment, item_id)
        mode = environment.get("mode")
        has_fixture_surface = bool(
            environment.get("db_fixtures")
            or environment.get("base_images")
            or raw.get("attachments")
            or raw.get("attachment")
        )
        if (
            mode == "synthetic"
            and status == "incomplete"
            and not has_fixture_surface
            and not environment.get("services")
        ):
            raise ValueError(
                f"{item_id}: incomplete synthetic evals must declare the fixtures/services they are missing"
            )
    evaluators = raw.get("evaluators")
    if evaluators:
        _validate_evaluators(evaluators, item_id)


def load_raw_catalog(path: Path = DEFAULT_CATALOG) -> list[dict[str, Any]]:
    with path.open() as f:
        data = json.load(f)
    if not isinstance(data, list) or not data:
        raise ValueError(f"{path} must contain a non-empty JSON array of tasks")
    return data


def validate_catalog(path: Path = DEFAULT_CATALOG) -> list[dict[str, Any]]:
    """Validate the full unified catalog; returns the raw entries on success."""
    tasks = load_raw_catalog(path)
    for raw in tasks:
        validate_task_contract(raw)
    names = [t.get("name") for t in tasks]
    if len(names) != len(set(names)):
        raise ValueError(f"{path}: task names must be unique")
    return tasks


def _validate_idea(raw: dict[str, Any]) -> LongHorizonIdea:
    item_id = _require_non_empty_string(raw, "id", "<idea>")
    status = _require_non_empty_string(raw, "status", item_id)
    if status not in IDEA_STATUSES:
        raise ValueError(f"{item_id}: status must be one of {sorted(IDEA_STATUSES)}")
    environment_modes = _require_string_list(raw, "likely_environment_modes", item_id)
    unknown_env = set(environment_modes) - ENVIRONMENT_MODES
    if unknown_env:
        raise ValueError(f"{item_id}: unknown environment modes {sorted(unknown_env)}")
    evaluation_methods = _require_string_list(raw, "likely_evaluation_methods", item_id)
    unknown_eval = set(evaluation_methods) - EVALUATION_METHODS
    if unknown_eval:
        raise ValueError(f"{item_id}: unknown evaluation methods {sorted(unknown_eval)}")
    return LongHorizonIdea(
        id=item_id,
        title=_require_non_empty_string(raw, "title", item_id),
        raw_user_idea=_require_non_empty_string(raw, "raw_user_idea", item_id),
        normalized_goal=_require_non_empty_string(raw, "normalized_goal", item_id),
        status=status,
        likely_environment_modes=environment_modes,
        likely_evaluation_methods=evaluation_methods,
        safety_notes=_require_non_empty_string(raw, "safety_notes", item_id),
    )


def load_idea_bank(path: Path = DEFAULT_IDEA_BANK) -> list[LongHorizonIdea]:
    with path.open() as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    if data.get("version") != CATALOG_VERSION:
        raise ValueError(f"{path}: version must be {CATALOG_VERSION}")
    ideas = data.get("ideas")
    if not isinstance(ideas, list) or not ideas:
        raise ValueError(f"{path}: ideas must be a non-empty list")
    parsed = [_validate_idea(raw) for raw in ideas]
    ids = [item.id for item in parsed]
    if len(ids) != len(set(ids)):
        raise ValueError(f"{path}: idea ids must be unique")
    return parsed
