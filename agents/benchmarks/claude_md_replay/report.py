"""Compare arms across replay results: rule breaks, diff size, tests, cost and time."""

from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any, Iterable, Optional


def load_results(roots: Iterable[Path]) -> list[dict[str, Any]]:
    results = []
    for root in roots:
        for path in sorted(Path(root).rglob("result.json")):
            try:
                row = json.loads(path.read_text())
            except json.JSONDecodeError:
                continue
            row["_path"] = str(path)
            results.append(row)
    return results


def _mean(values: list[float]) -> Optional[float]:
    return round(statistics.fmean(values), 3) if values else None


def _row_metrics(row: dict[str, Any]) -> dict[str, Any]:
    claude = row.get("claude") or {}
    summary = claude.get("summary") or {}
    observation = row.get("observation") or {}
    diff = observation.get("diff") or {}
    grade = row.get("grade") or {}
    tokens = [summary.get(k) for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")]
    return {
        "completed": "observation" in row,
        "infra": bool(claude.get("infra")),
        "cost_usd": summary.get("cost_usd"),
        "seconds": claude.get("duration_seconds"),
        "turns": summary.get("num_turns"),
        "tokens": sum(int(t) for t in tokens if isinstance(t, (int, float))) if any(t is not None for t in tokens) else None,
        "breaks": observation.get("breaks"),
        "break_counts": observation.get("break_counts") or {},
        "production_lines": diff.get("production_lines_changed"),
        "test_lines": diff.get("test_lines_changed"),
        "tests_passed": grade.get("passed") if grade else None,
    }


def compare(results: list[dict[str, Any]]) -> dict[str, Any]:
    cells: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in results:
        cells.setdefault((str(row.get("task")), str(row.get("arm"))), []).append(_row_metrics(row))
    table = []
    for (task, arm), rows in sorted(cells.items()):
        done = [r for r in rows if r["completed"] and not r["infra"]]

        def nums(key: str) -> list[float]:
            return [float(r[key]) for r in done if isinstance(r[key], (int, float)) and not isinstance(r[key], bool)]

        graded = [r["tests_passed"] for r in done if r["tests_passed"] is not None]
        rules: dict[str, int] = {}
        for r in done:
            for rule, count in r["break_counts"].items():
                rules[rule] = rules.get(rule, 0) + int(count)
        table.append(
            {
                "task": task,
                "arm": arm,
                "runs": len(rows),
                "completed": len(done),
                "infra": sum(1 for r in rows if r["infra"]),
                "breaks_total": int(sum(nums("breaks"))),
                "break_rules": dict(sorted(rules.items())),
                "production_lines_mean": _mean(nums("production_lines")),
                "test_lines_mean": _mean(nums("test_lines")),
                "tests_passed": f"{sum(1 for g in graded if g)}/{len(graded)}" if graded else None,
                "cost_usd_mean": _mean(nums("cost_usd")),
                "seconds_mean": _mean(nums("seconds")),
                "turns_mean": _mean(nums("turns")),
                "tokens_mean": _mean(nums("tokens")),
            }
        )
    arms: dict[str, dict[str, Any]] = {}
    for arm in sorted({row["arm"] for row in table}):
        rows = [row for row in table if row["arm"] == arm]
        arms[arm] = {
            "runs": sum(r["runs"] for r in rows),
            "breaks_total": sum(r["breaks_total"] for r in rows),
            "cost_usd_total": round(sum((r["cost_usd_mean"] or 0) * r["completed"] for r in rows), 2),
            "production_lines_total": round(sum((r["production_lines_mean"] or 0) * r["completed"] for r in rows), 1),
        }
    return {"cells": table, "arms": arms}


def render(report: dict[str, Any]) -> str:
    header = f"{'task':<22} {'arm':<4} {'runs':>4} {'brk':>4} {'rules':<16} {'prodLOC':>8} {'tests':>6} {'cost$':>7} {'min':>6} {'turns':>6}"
    lines = [header, "-" * len(header)]
    for row in report["cells"]:
        rules = ",".join(f"{k}x{v}" for k, v in row["break_rules"].items()) or "-"
        minutes = f"{row['seconds_mean'] / 60:.1f}" if row["seconds_mean"] is not None else "-"
        lines.append(
            f"{row['task'][:22]:<22} {row['arm']:<4} {row['runs']:>4} {row['breaks_total']:>4} {rules[:16]:<16} "
            f"{row['production_lines_mean'] if row['production_lines_mean'] is not None else '-':>8} "
            f"{row['tests_passed'] or '-':>6} {row['cost_usd_mean'] if row['cost_usd_mean'] is not None else '-':>7} "
            f"{minutes:>6} {row['turns_mean'] if row['turns_mean'] is not None else '-':>6}"
        )
    for arm, totals in report["arms"].items():
        lines.append(f"arm {arm}: runs={totals['runs']} breaks={totals['breaks_total']} cost=${totals['cost_usd_total']} prodLOC={totals['production_lines_total']}")
    return "\n".join(lines)
