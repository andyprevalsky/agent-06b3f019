#!/usr/bin/env python3
"""Aggregate one isolated cloudbench run artifact per task into one batch run."""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sys
from pathlib import Path


_PROVENANCE_MODULE_PATH = Path(__file__).resolve().with_name(
    "cloudbench_execution_provenance.py"
)
_PROVENANCE_SPEC = importlib.util.spec_from_file_location(
    "rose_cloudbench_execution_provenance", _PROVENANCE_MODULE_PATH
)
if _PROVENANCE_SPEC is None or _PROVENANCE_SPEC.loader is None:
    raise ImportError(
        f"could not load cloudbench execution provenance module: {_PROVENANCE_MODULE_PATH}"
    )
_PROVENANCE_MODULE = importlib.util.module_from_spec(_PROVENANCE_SPEC)
_PROVENANCE_SPEC.loader.exec_module(_PROVENANCE_MODULE)
load_provenance = _PROVENANCE_MODULE.load_provenance
load_task_matrix = _PROVENANCE_MODULE.load_task_matrix
validate_run_provenance = _PROVENANCE_MODULE.validate_run_provenance
validate_task_matrix_binding = _PROVENANCE_MODULE.validate_task_matrix_binding


PROVIDER_ORDER = (
    "codex_token",
    "claude_oauth_token",
    "gpt_api_key",
    "anthropic_api_key",
    "openrouter_model_1",
    "openrouter_model_2",
)


def merge_usage_breakdowns(breakdowns) -> dict:
    """Merge already-classified usage without importing the full agents tree.

    This script is copied into the fleet's minimal immutable script snapshot,
    where the ``benchmarks`` package is intentionally unavailable.
    """
    merged: dict[str, dict] = {}
    for breakdown in breakdowns:
        for provider, usage in breakdown.items():
            provider_total = merged.setdefault(
                provider,
                {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "models": {}},
            )
            for field in ("calls", "input_tokens", "output_tokens"):
                provider_total[field] += int(usage.get(field) or 0)
            provider_total["cost_usd"] += float(usage.get("cost_usd") or 0)
            for model, model_usage in (usage.get("models") or {}).items():
                model_total = provider_total["models"].setdefault(
                    model,
                    {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0},
                )
                for field in ("calls", "input_tokens", "output_tokens"):
                    model_total[field] += int(model_usage.get(field) or 0)
                model_total["cost_usd"] += float(model_usage.get("cost_usd") or 0)
    for provider in PROVIDER_ORDER:
        merged.setdefault(
            provider,
            {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "models": {}},
        )
    merged = {
        provider: merged[provider]
        for provider in (*PROVIDER_ORDER, "unclassified")
        if provider in merged
    }
    for usage in merged.values():
        usage["cost_usd"] = round(usage["cost_usd"], 8)
        for model_usage in usage["models"].values():
            model_usage["cost_usd"] = round(model_usage["cost_usd"], 8)
    return merged


def _display_status(task: dict) -> str:
    if bool(task.get("passed")):
        return "passed"
    status = str(task.get("benchmark_status") or task.get("status") or "").upper()
    if status == "SKIPPED":
        return "skipped"
    if status in {"INFRA_ERROR", "ERROR", "CANCELLED", "CAPACITY_DEFERRED"}:
        return "error"
    return "failed"


def _capacity_deferral(fleet_dir: Path) -> str | None:
    """The controller's own pre-provider capacity deferral reason, if recorded.

    run-bench-fleet writes this marker only when its bounded wait for the
    emergency teardown disk reserve expired before any provider mutation.
    Anything unreadable or malformed keeps the INFRA_ERROR projection.
    """
    marker = fleet_dir / "_batch/capacity-deferred.json"
    try:
        if marker.is_symlink() or not marker.is_file() or marker.stat().st_size > 4096:
            return None
        value = json.loads(marker.read_text())
    except (OSError, ValueError):
        return None
    wait = value.get("wait_seconds") if isinstance(value, dict) else None
    if (value.get("schema") != "cloudbench-capacity-deferred-v1" or value.get("reason") != "cleanup_disk_reserve"
            or type(wait) is not int or wait < 0):
        return None
    return (f"local disk could not hold the emergency teardown reserve within the {wait}s capacity wait; "
            "no provider mutation (capacity, not infrastructure)")


def _optional_number(value) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if math.isfinite(number):
            return number
    return None


def _terminal_report_card(result: dict, fleet_dir: Path) -> dict:
    task_cards = []
    modes = set()
    for task in result["tasks"]:
        duration = _optional_number(task.get("duration_seconds"))
        cost_cents = _optional_number(task.get("cost_cents"))
        infra_usd = _optional_number(task.get("infra_usd"))
        mode = str(task.get("world_model_mode") or "").lower() or None
        if mode:
            modes.add(mode)
        task_cards.append(
            {
                "name": str(task.get("name") or ""),
                "status": _display_status(task),
                "duration_s": round(duration, 1) if duration is not None else None,
                "cost_usd": round(cost_cents / 100, 4) if cost_cents is not None else None,
                "agent_url": task.get("agent_url"),
                "agent_id": task.get("agent_id"),
                "failure_reason": task.get("failure_reason"),
                "lifecycle_stage": task.get("lifecycle_stage"),
                "tokens_in": int(task.get("tokens_in") or 0),
                "tokens_out": int(task.get("tokens_out") or 0),
                "world_model_mode": mode,
                "fast_mode": (
                    bool(task.get("fast_mode_cache_enabled"))
                    if "fast_mode_cache_enabled" in task
                    else None
                ),
                # Preserve measured provider cache inputs separately from the legacy
                # cache_hit_pct ratio and the provider-speed Fast Mode button.
                **{key: task[key] for key in (
                    "prompt_cache_read_input_tokens", "prompt_cache_creation_input_tokens",
                    "prompt_cache_uncached_input_tokens",
                ) if key in task},
                "infra_usd": round(infra_usd, 4) if infra_usd is not None else None,
            }
        )
    passed = sum(card["status"] == "passed" for card in task_cards)
    failed = sum(card["status"] in {"failed", "error"} for card in task_cards)
    transient = sum(card["status"] == "transient" for card in task_cards)
    skipped = sum(card["status"] == "skipped" for card in task_cards)
    completed = passed + failed + transient + skipped
    agents_llm_usd = round(
        sum(card["cost_usd"] or 0 for card in task_cards),
        4,
    )
    known_infra = [card["infra_usd"] for card in task_cards if card["infra_usd"] is not None]
    infra_usd = round(sum(known_infra), 4) if known_infra else None
    total_usd = round(agents_llm_usd + (infra_usd or 0), 4)
    cache_hit_pct = _optional_number(result["summary"].get("cache_hit_pct"))
    code_path = fleet_dir / "_batch/code.txt"
    try:
        code = code_path.read_text().strip()
    except OSError:
        code = ""
    card = {
        "run_id": result["run_id"],
        "timestamp": result["timestamp"],
        "status": result["status"],
        "controller_exit_code": result.get("controller_exit_code"),
        "code": code,
        "elapsed_s": result["elapsed_s"],
        "world_model_mode": (
            next(iter(modes)) if len(modes) == 1 else "mixed"
        )
        if modes
        else "real",
        "tasks": {
            "total": len(task_cards),
            "running": 0,
            "completed": completed,
            "queued": 0,
        },
        "results": {
            "passed": passed,
            "failed": failed,
            "transient": transient,
            "success_rate": round(passed / max(1, passed + failed), 3),
        },
        "cost": {
            "agents_llm_usd": agents_llm_usd,
            "wmh_grounding_usd": None,
            "infra_usd": infra_usd,
            "total_usd": total_usd,
            "fast_cache_hit_rate": (
                round(cache_hit_pct / 100, 4) if cache_hit_pct is not None else None
            ),
        },
        "infra": None,
        "metadata": {
            "tokens_in": sum(card["tokens_in"] for card in task_cards),
            "tokens_out": sum(card["tokens_out"] for card in task_cards),
            "agent_tokens_in": sum(card["tokens_in"] for card in task_cards),
            "agent_tokens_out": sum(card["tokens_out"] for card in task_cards),
            "wmh_tokens_in": 0,
            "wmh_tokens_out": 0,
        },
        "per_task": task_cards,
    }
    if "execution_provenance" in result:
        card["execution_provenance"] = result["execution_provenance"]
        card["execution_task_matrix"] = result["execution_task_matrix"]
    return card


def _write_json_atomic(path: Path, value: dict) -> None:
    temporary = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    try:
        with temporary.open("w") as handle:
            handle.write(json.dumps(value, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def aggregate(
    fleet_dir: Path,
    expected_execution_provenance: dict | None = None,
    expected_execution_task_matrix: dict | None = None,
    controller_elapsed_seconds: float | None = None,
    controller_exit_code: int | None = None,
) -> dict:
    benches = json.loads((fleet_dir / "_batch/benches.json").read_text())
    # The startup/live producer owns the original controller clock. Terminal
    # refreshes preserve it; older artifacts without that field stay unknown.
    card_path = fleet_dir / "_batch/report-card.json"
    timestamp = (
        json.loads(card_path.read_text()).get("timestamp") or ""
        if card_path.is_file()
        else ""
    )
    if expected_execution_provenance is not None:
        if expected_execution_task_matrix is None:
            raise ValueError("expected execution task matrix is missing")
        matrix_errors = validate_task_matrix_binding(
            expected_execution_provenance, expected_execution_task_matrix
        )
        if matrix_errors:
            raise ValueError("; ".join(matrix_errors))
        actual_matrix = []
        for bench in benches:
            raw_mode = str(bench.get("mode") or "").lower()
            if raw_mode in {"sim", "simulate"}:
                mode = "simulate"
            elif raw_mode in {"real"}:
                mode = "real"
            else:
                raise ValueError(
                    f"aggregate bench has an invalid execution mode: {raw_mode!r}"
                )
            actual_matrix.append(
                {
                    "name": str(bench.get("name") or ""),
                    "world_model_mode": mode,
                }
            )
        if actual_matrix != expected_execution_task_matrix["tasks"]:
            raise ValueError(
                "aggregate benches/modes do not match the canonical execution task matrix"
            )
        expected_modes = {
            row["name"]: row["world_model_mode"]
            for row in expected_execution_task_matrix["tasks"]
        }
    else:
        expected_modes = {}
    tasks: list[dict] = []
    deferral = _capacity_deferral(fleet_dir)
    for bench in benches:
        name = str(bench["name"])
        path = fleet_dir / name / "cloudbench-run.json"
        if not path.is_file():
            missing_task = {
                "name": name,
                "passed": False,
                "status": "INFRA_ERROR",
                "failure_reason": "no current run artifact produced",
                "lifecycle_stage": _lifecycle_stage(fleet_dir / name),
            }
            if deferral is not None:
                missing_task.update(status="CAPACITY_DEFERRED", failure_reason=deferral)
            if expected_execution_provenance is not None:
                missing_task["execution_provenance"] = expected_execution_provenance
                missing_task["world_model_mode"] = expected_modes[name]
            tasks.append(missing_task)
            continue
        run = json.loads(path.read_text())
        if expected_execution_provenance is not None:
            provenance_errors = validate_run_provenance(
                run, expected_execution_provenance
            )
            if provenance_errors:
                raise ValueError(
                    f"{name}: " + "; ".join(provenance_errors)
                )
        candidates = run.get("tasks") or []
        if expected_execution_provenance is not None:
            if (
                not isinstance(candidates, list)
                or len(candidates) != 1
                or not isinstance(candidates[0], dict)
                or candidates[0].get("name") != name
            ):
                raise ValueError(
                    f"{name}: child run artifact must contain exactly one requested task"
                )
            task = candidates[0]
        else:
            task = next(
                (
                    candidate
                    for candidate in candidates
                    if isinstance(candidate, dict) and candidate.get("name") == name
                ),
                None,
            )
        if task is None:
            missing_task = {
                "name": name,
                "passed": False,
                "status": "INFRA_ERROR",
                "failure_reason": "run artifact did not contain the requested task",
                "lifecycle_stage": _lifecycle_stage(fleet_dir / name),
            }
            if expected_execution_provenance is not None:
                missing_task["execution_provenance"] = expected_execution_provenance
                missing_task["world_model_mode"] = expected_modes[name]
            tasks.append(missing_task)
        else:
            if (
                expected_execution_provenance is not None
                and task.get("world_model_mode") != expected_modes[name]
            ):
                raise ValueError(
                    f"{name}: task world_model_mode does not match the canonical execution task matrix"
                )
            task = dict(task)
            directory = fleet_dir / name
            task["lifecycle_stage"] = _lifecycle_stage(directory) or "evaluated"
            tasks.append(task)
    passed = sum(bool(task.get("passed")) for task in tasks)
    costs = sum(float(task.get("cost_cents") or 0) for task in tasks)
    durations = [float(task.get("duration_seconds") or 0) for task in tasks]
    cache_read = sum(int(task.get("cache_read_input_tokens") or 0) for task in tasks)
    cache_create = sum(int(task.get("cache_creation_input_tokens") or 0) for task in tasks)
    cache_total = cache_read + cache_create
    llm_usage = merge_usage_breakdowns(
        task.get("llm_usage_by_provider") or {} for task in tasks
    )
    result = {
        "run_id": fleet_dir.name,
        "timestamp": timestamp,
        "elapsed_s": round(
            controller_elapsed_seconds
            if controller_elapsed_seconds is not None
            else max(durations, default=0),
            1,
        ),
        "suite": "cloud-fleet",
        "source": "cloud-fleet",
        "base_url": "cloud-fleet",
        "summary": {
            "total": len(tasks),
            "passed": passed,
            "failed": len(tasks) - passed,
            "total_cost_cents": round(costs, 4),
            "total_duration_seconds": round(sum(durations), 1),
            "pass_rate": passed / max(1, len(tasks)),
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_create,
            "cache_hit_pct": round(100 * cache_read / cache_total, 1) if cache_total else None,
            "llm_usage_by_provider": llm_usage,
        },
        "memory_summary": None,
        "tasks": tasks,
    }
    result["status"] = (
        "passed"
        if tasks and passed == len(tasks) and (controller_exit_code is None or controller_exit_code == 0)
        else "failed"
    )
    if controller_exit_code is not None:
        result["controller_exit_code"] = controller_exit_code
    if expected_execution_provenance is not None:
        result["execution_provenance"] = expected_execution_provenance
        result["execution_task_matrix"] = expected_execution_task_matrix
    return result


def _lifecycle_stage(directory: Path) -> str | None:
    if (directory / "bench-e2e.finished-epoch").is_file():
        return "released"
    return "teardown" if (directory / "benchmark-child.finished").is_file() else None


def _preserved_terminal_projection(args, expected_provenance, expected_matrix):
    """Refresh cleanup metadata without re-reading or replacing task outcomes."""
    if args.output.is_symlink():
        raise ValueError("terminal outcome path is a symlink")
    result = json.loads(args.output.read_text())
    benches = json.loads((args.fleet_dir / "_batch/benches.json").read_text())
    names = [row["name"] for row in benches]
    if (result.get("run_id") != args.fleet_dir.name or not result.get("timestamp")
            or result.get("status") not in {"passed", "failed"}
            or [task["name"] for task in result["tasks"]] != names
            or len(set(names)) != len(names)):
        raise ValueError("terminal outcome identity does not match the original task list")
    if expected_provenance is not None:
        errors = validate_run_provenance(result, expected_provenance)
        if errors or result.get("execution_task_matrix") != expected_matrix:
            raise ValueError("terminal outcome execution provenance changed")
    for task in result["tasks"]:
        task["lifecycle_stage"] = (
            _lifecycle_stage(args.fleet_dir / task["name"]) or task.get("lifecycle_stage")
        )
    return result


def _publish_aggregate(args: argparse.Namespace) -> int:
    expected_execution_provenance = None
    expected_execution_task_matrix = None
    if (args.expected_execution_provenance_file is None) != (
        args.expected_execution_task_matrix_file is None
    ):
        print(
            "aggregate requires execution provenance and task matrix together",
            file=sys.stderr,
        )
        return 2
    if args.expected_execution_provenance_file is not None:
        try:
            expected_execution_provenance = load_provenance(
                args.expected_execution_provenance_file
            )
            expected_execution_task_matrix = load_task_matrix(
                args.expected_execution_task_matrix_file
            )
        except (OSError, ValueError) as exc:
            print(f"aggregate rejected expected execution provenance: {exc}", file=sys.stderr)
            return 1
    raw_elapsed = os.environ.get("CLOUDBENCH_CONTROLLER_ELAPSED_SECONDS")
    controller_elapsed_seconds = None
    if raw_elapsed is not None:
        try:
            controller_elapsed_seconds = float(raw_elapsed)
        except ValueError:
            print("aggregate rejected invalid controller elapsed seconds", file=sys.stderr)
            return 2
        if not math.isfinite(controller_elapsed_seconds) or controller_elapsed_seconds < 0:
            print("aggregate rejected invalid controller elapsed seconds", file=sys.stderr)
            return 2
    raw_controller_exit = os.environ.get("CLOUDBENCH_CONTROLLER_EXIT_CODE")
    controller_exit_code = None
    if raw_controller_exit is not None:
        try:
            controller_exit_code = int(raw_controller_exit)
        except ValueError:
            print("aggregate rejected invalid controller exit code", file=sys.stderr)
            return 2
        if controller_exit_code < 0 or controller_exit_code > 255:
            print("aggregate rejected invalid controller exit code", file=sys.stderr)
            return 2
    fleet_dir = args.fleet_dir
    output = args.output
    try:
        if args.preserve_terminal_outcomes:
            result = _preserved_terminal_projection(
                args, expected_execution_provenance, expected_execution_task_matrix
            )
        else:
            result = aggregate(
                fleet_dir,
                expected_execution_provenance,
                expected_execution_task_matrix,
                controller_elapsed_seconds,
                controller_exit_code,
            )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"aggregate rejected child execution provenance: {exc}", file=sys.stderr)
        return 1
    report_card = _terminal_report_card(result, fleet_dir)
    _write_json_atomic(output, result)
    _write_json_atomic(output.with_name("report-card.json"), report_card)
    usage_artifact = {
        "run_id": result["run_id"],
        "providers": result["summary"]["llm_usage_by_provider"],
    }
    _write_json_atomic(output.with_name("llm-usage.json"), usage_artifact)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("fleet_dir", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--expected-execution-provenance-file", type=Path)
    parser.add_argument("--expected-execution-task-matrix-file", type=Path)
    parser.add_argument("--preserve-terminal-outcomes", action="store_true")
    args = parser.parse_args()
    status = 1
    try:
        status = _publish_aggregate(args)
    except (OSError, TypeError, ValueError) as exc:
        print(f"aggregate publication failed: {exc}", file=sys.stderr)
    finally:
        if status != 0 and not args.preserve_terminal_outcomes:
            for path in (args.output, args.output.with_name("report-card.json"), args.output.with_name("llm-usage.json")):
                path.unlink(missing_ok=True)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
