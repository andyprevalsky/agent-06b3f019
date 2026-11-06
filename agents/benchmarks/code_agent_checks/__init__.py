"""Static checks for the code-agent benchmark (``code-agent-rose-repo`` in tasks.json).

The benchmark's root Rose agent has the Rose GitHub repo attached (its Project)
and spawns a Claude Code agent that works in that checkout. Every issue we
gate on is one check type, so lanes can add checks without touching each other's code:

    tasks.json evaluators[].checks[] {"type": "code_agent_<name>", ...}
        │  run_benchmark._run_declared_evaluators
        ├─► hydrate(data)            evidence.collect → data["_benchmark"]["code_agent_evidence"]
        │                            (+ evidence["context"], + evidence["run"] for python_run lanes)
        └─► run_check(data, check)   native:   CHECKS[type](evidence, check) → (ok, reason)
                                     external: external.run(check, evidence) → (ok, reason)

Two ways to add a check:
  native    ``code_agent_checks/<name>.py`` with ``CHECK_TYPE = "code_agent_<name>"`` and
            ``def check(evidence: dict, config: dict) -> tuple[bool, str]``; add it to ``_MODULES``.
  external  the lane's own module/script/spec; add ``"code_agent_<name>": External(kind, target)`` to
            ``external.EXTERNAL`` (kinds and call shapes are documented in ``external.py``).
Every type is registered with long_horizon.RUNTIME_STATIC_CHECK_TYPES. Declare it in the task's
``evaluators`` and add offline pass/fail cases to ``code_agent_checks_test.py``. An external lane
file that is not on the branch fails its check closed with an actionable reason.
"""

from __future__ import annotations

from typing import Any, Callable

from benchmarks.code_agent_checks import external, one_session_per_spawn, startup_time

CheckFn = Callable[[dict, dict], "tuple[bool, str]"]

_MODULES = (startup_time, one_session_per_spawn)

CHECKS: dict[str, CheckFn] = {module.CHECK_TYPE: module.check for module in _MODULES}

CHECK_TYPES: frozenset[str] = frozenset(CHECKS) | frozenset(external.EXTERNAL)

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


async def hydrate(data: dict, *, benchmark: str, base_url: str | None, evaluators: list[dict]) -> None:
    """Collect the run's code-agent evidence once, before any check reads it."""
    from benchmarks.code_agent_checks import evidence

    state = data.setdefault("_benchmark", {})
    collected = await evidence.collect(data, benchmark=benchmark, base_url=base_url)
    collected["context"] = external.context(data, base_url, collected["agent_ids"])
    declared = [c["type"] for c in _declared(evaluators) if c["type"] in external.EXTERNAL]
    modules = {external.EXTERNAL[t].module for t in declared if external.EXTERNAL[t].kind == "python_run"}
    if modules:
        collected["run"] = await external.hydrate_runs(modules, collected["context"])
    state[EVIDENCE_KEY] = collected


async def record_evidence(data: dict, *, benchmark: str, base_url: str | None) -> None:
    """Evidence for a run whose declared evaluators did not run (a failed or timed-out run).

    The run record then still carries the per-phase startup and session rows that
    explain the failure. Best effort: a collection error is kept in the evidence.
    """
    from benchmarks.code_agent_checks import evidence

    state = data.setdefault("_benchmark", {})
    try:
        state[EVIDENCE_KEY] = await evidence.collect(data, benchmark=benchmark, base_url=base_url)
    except Exception as exc:  # diagnostics must never change the run's verdict
        state[EVIDENCE_KEY] = {"collect_error": f"{type(exc).__name__}: {exc}"[:300]}


def run_check(data: dict, check: dict) -> tuple[bool, str]:
    evidence: Any = (data.get("_benchmark") or {}).get(EVIDENCE_KEY)
    if not isinstance(evidence, dict):
        return False, "code-agent evidence was not collected (hydrate did not run)"
    if check.get("type") in external.EXTERNAL:
        return external.run(check, evidence)
    return CHECKS[str(check.get("type"))](evidence, check)
