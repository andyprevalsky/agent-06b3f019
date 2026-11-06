"""Startup time of a code agent with the Rose repo attached, per phase.

Phases of one spawn (worker clock, evidence.build_spawns):

    create_requested_at ─create─► session_created_at ─project_startup─► cli_launch_at
        ─cli_init─► cli_ready_at (CLI system.init) ─first_output─► first agent_message
    ready = create_requested_at → cli_ready_at   ← the gated number

``create`` is split further by the backend's "Code session startup timings"
line (``backend.<phase>``: slot_wait, prepare, sandbox, sandbox_setup,
workspace = project clone/refresh, ws_ready, preview, record).

Check config: {"type": "code_agent_startup_time", "max_ready_seconds": N,
"min_spawns": 1, "require_project_checkout": true}. Fails closed when a spawn
never reached CLI ready, when the backend split is missing with
require_project_checkout, or when any spawn's ready exceeds the budget.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

CHECK_TYPE = "code_agent_startup_time"
PROJECT_CHECKOUT_SOURCES = {"remote", "snapshot"}

_WORKER_PHASES = (
    ("create", "create_requested_at", "session_created_at"),
    ("project_startup", "session_created_at", "cli_launch_at"),
    ("cli_init", "cli_launch_at", "cli_ready_at"),
    ("ready", "create_requested_at", "cli_ready_at"),
    ("first_output", "cli_ready_at", "first_output_at"),
)


def _at(value: object) -> Optional[datetime]:
    return datetime.fromisoformat(value) if isinstance(value, str) and value else None


def spawn_phases(spawn: dict) -> dict[str, float]:
    """Milliseconds per known phase of one spawn (absent endpoints are omitted)."""
    phases: dict[str, float] = {}
    for name, start_key, end_key in _WORKER_PHASES:
        start, end = _at(spawn.get(start_key)), _at(spawn.get(end_key))
        if start is not None and end is not None:
            phases[name] = round((end - start).total_seconds() * 1000, 1)
    backend = spawn.get("backend") if isinstance(spawn.get("backend"), dict) else {}
    for phase, ms in (backend.get("phases_ms") or {}).items():
        if isinstance(ms, (int, float)):
            phases[f"backend.{phase}"] = float(ms)
    if isinstance(backend.get("total_ms"), (int, float)):
        phases["backend.total"] = float(backend["total_ms"])
    return phases


def _summary(spawn: dict, phases: dict[str, float]) -> str:
    def s(name: str) -> str:
        return f"{phases[name] / 1000:.1f}s" if name in phases else "n/a"

    backend = " ".join(
        f"{name.removeprefix('backend.')}={phases[name] / 1000:.1f}s"
        for name in phases
        if name.startswith("backend.") and name != "backend.total"
    )
    source = (spawn.get("backend") or {}).get("checkoutSource")
    return (
        f"task {str(spawn.get('task_id'))[:8]}: ready {s('ready')} = create {s('create')}"
        f" [{backend or 'no backend split'}; checkout={source}]"
        f" + project_startup {s('project_startup')} + cli_init {s('cli_init')};"
        f" first_output {s('first_output')}; create_attempts {spawn.get('create_attempts')},"
        f" backend_creates {spawn.get('backend_creates')}"
    )


def check(evidence: dict, config: dict) -> tuple[bool, str]:
    budget = config.get("max_ready_seconds")
    if not isinstance(budget, (int, float)) or budget <= 0:
        return False, f"{CHECK_TYPE}: max_ready_seconds must be a positive number"
    spawns = [s for s in evidence.get("spawns") or [] if isinstance(s, dict)]
    min_spawns = int(config.get("min_spawns", 1))
    if len(spawns) < min_spawns:
        return False, (
            f"{CHECK_TYPE}: {len(spawns)} code-agent create(s) observed, expected >= {min_spawns}"
            f" (sources {evidence.get('sources')})"
        )
    summaries, failures = [], []
    for spawn in spawns:
        phases = spawn_phases(spawn)
        summaries.append(_summary(spawn, phases))
        if "ready" not in phases:
            failures.append(f"task {str(spawn.get('task_id'))[:8]} never reached CLI ready")
            continue
        if config.get("require_project_checkout", True):
            backend = spawn.get("backend") or {}
            if not backend.get("projectId") or backend.get("checkoutSource") not in PROJECT_CHECKOUT_SOURCES:
                failures.append(
                    f"task {str(spawn.get('task_id'))[:8]} did not start in a project checkout"
                    f" (projectId={backend.get('projectId')}, checkout={backend.get('checkoutSource')})"
                )
        if phases["ready"] > budget * 1000:
            failures.append(
                f"task {str(spawn.get('task_id'))[:8]} ready {phases['ready'] / 1000:.1f}s > budget {budget}s"
            )
    detail = " | ".join(summaries)
    if failures:
        return False, f"{CHECK_TYPE} failed: {'; '.join(failures)} || {detail}"
    return True, f"{CHECK_TYPE} ok (budget {budget}s): {detail}"
