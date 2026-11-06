"""Static checks for the code-agent benchmark (``code-agent-rose-repo`` in tasks.json).

The benchmark's root Rose agent has the Rose GitHub repo attached (its Project)
and spawns a Claude Code agent that works in that checkout. Every issue we
gate on is one check type in its own module, so lanes can add checks without
touching each other's code:

    tasks.json evaluators[].checks[] {"type": "code_agent_<name>", ...}
        │  run_benchmark._run_declared_evaluators
        ├─► hydrate(data)            evidence.collect → data["_benchmark"]["code_agent_evidence"]
        │                            (+ evidence["run"] from an external module's hydrate)
        └─► run_check(data, check)   native:   CHECKS[type](evidence, check) → (ok, reason)
                                     external: module.fn(evidence["run"], **config) → {"passed", "detail"}

Two ways to add a check:
  native    ``code_agent_checks/<name>.py`` with ``CHECK_TYPE = "code_agent_<name>"`` and
            ``def check(evidence: dict, config: dict) -> tuple[bool, str]``; add it to ``_MODULES``.
  external  a lane's own module: ``def check_x(run: dict, **config) -> dict`` returning at least
            ``{"passed": bool, "detail": str}``, where ``run`` is that module's
            ``async def hydrate_code_agent_run(base_url, api_key, user_id, root_agent_id) -> dict``;
            add ``"code_agent_<name>": (module, function)`` to ``EXTERNAL_CHECKS``.
Every type is registered with long_horizon.RUNTIME_STATIC_CHECK_TYPES. Declare it in
the task's ``evaluators`` and add offline pass/fail cases to ``code_agent_checks_test.py``.
An external module that is not importable fails its check closed.
"""

from __future__ import annotations

import importlib
import os
from typing import Any, Callable

from benchmarks.code_agent_checks import one_session_per_spawn, startup_time

CheckFn = Callable[[dict, dict], "tuple[bool, str]"]

_MODULES = (startup_time, one_session_per_spawn)

CHECKS: dict[str, CheckFn] = {module.CHECK_TYPE: module.check for module in _MODULES}

# Checks owned by other lanes, called by name from their module.
EXTERNAL_HYDRATE = "hydrate_code_agent_run"
EXTERNAL_CHECKS: dict[str, tuple[str, str]] = {
    # Lane A (spawn/messaging): one code agent per spawn; send_message_to_agent reaches its CLI.
    "code_agent_single_code_agent": ("benchmarks.code_agent_run_checks", "check_single_code_agent"),
    "code_agent_message_reached": ("benchmarks.code_agent_run_checks", "check_message_reached_code_agent"),
}

CHECK_TYPES: frozenset[str] = frozenset(CHECKS) | frozenset(EXTERNAL_CHECKS)

EVIDENCE_KEY = "code_agent_evidence"


def _declared(evaluators: list[dict]) -> list[dict]:
    return [
        check
        for evaluator in evaluators
        if evaluator.get("method") == "static_check"
        for check in evaluator.get("checks", [])
        if isinstance(check, dict) and check.get("type") in CHECK_TYPES
    ]


def declares_check(evaluators: list[dict]) -> bool:
    return bool(_declared(evaluators))


async def _external_run(data: dict, modules: set[str], base_url: str | None) -> dict:
    """Each external module's own hydrate output for this run's root (errors kept, not raised)."""
    from benchmarks.run_benchmark import API_KEY, _current_benchmark_user_id

    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    root = str(agent.get("agent_id") or agent.get("id") or "")
    runs: dict[str, Any] = {}
    for name in sorted(modules):
        try:
            hydrate = getattr(importlib.import_module(name), EXTERNAL_HYDRATE)
            runs[name] = await hydrate(base_url or "", API_KEY or os.environ.get("BACKEND_API_KEY", ""),
                                       _current_benchmark_user_id(), root)
        except Exception as exc:  # the dependent checks fail closed with this reason
            runs[name] = {"error": f"{type(exc).__name__}: {exc}"[:300]}
    return runs


async def hydrate(data: dict, *, benchmark: str, base_url: str | None, evaluators: list[dict]) -> None:
    """Collect the run's code-agent evidence once, before any check reads it."""
    from benchmarks.code_agent_checks import evidence

    state = data.setdefault("_benchmark", {})
    collected = await evidence.collect(data, benchmark=benchmark, base_url=base_url)
    modules = {EXTERNAL_CHECKS[c["type"]][0] for c in _declared(evaluators) if c["type"] in EXTERNAL_CHECKS}
    if modules:
        collected["run"] = await _external_run(data, modules, base_url)
    state[EVIDENCE_KEY] = collected


def _run_external(evidence: dict, check: dict) -> tuple[bool, str]:
    module_name, function = EXTERNAL_CHECKS[str(check["type"])]
    run = (evidence.get("run") or {}).get(module_name)
    if not isinstance(run, dict) or "error" in run:
        return False, f"{check['type']}: {module_name} evidence unavailable ({(run or {}).get('error')})"
    try:
        fn = getattr(importlib.import_module(module_name), function)
    except (ImportError, AttributeError) as exc:
        return False, f"{check['type']}: {module_name}.{function} is not available ({exc})"
    result = fn(run, **{k: v for k, v in check.items() if k != "type"})
    return bool(result.get("passed")), f"{check['type']}: {result.get('detail')}"


def run_check(data: dict, check: dict) -> tuple[bool, str]:
    evidence: Any = (data.get("_benchmark") or {}).get(EVIDENCE_KEY)
    if not isinstance(evidence, dict):
        return False, "code-agent evidence was not collected (hydrate did not run)"
    if check.get("type") in EXTERNAL_CHECKS:
        return _run_external(evidence, check)
    return CHECKS[str(check.get("type"))](evidence, check)
