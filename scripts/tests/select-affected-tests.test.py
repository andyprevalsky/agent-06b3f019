#!/usr/bin/env python3
"""Structural gate for the /deploy change->test selector.

Fails when a test file cannot be auto-mapped to a lane, a lane cannot fall
back to running everything, or one of the selector's safety rules regresses
(run_all triggers, unknown files, upstream/cross-package reachability).
"""

from __future__ import annotations

import sys
import builtins
import contextlib
import io
import runpy
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import select_affected_tests as sat

FAILURES: list[str] = []


def check(condition: bool, message: str) -> None:
    print(("PASS " if condition else "FAIL ") + message)
    if not condition:
        FAILURES.append(message)


def check_coverage_map_dependency_preflight() -> None:
    namespace = runpy.run_path(str(ROOT / "scripts/test-map/build_agents_coverage_map.py"))
    original_import = builtins.__import__

    def without_coverage(name, *args, **kwargs):
        if name == "coverage":
            raise ImportError("coverage missing in invoking interpreter")
        return original_import(name, *args, **kwargs)

    error = io.StringIO()
    with patch.object(sys, "argv", ["build_agents_coverage_map.py"]), \
         patch("subprocess.run") as runner, \
         patch("builtins.__import__", side_effect=without_coverage), contextlib.redirect_stderr(error):
        try:
            code = namespace["main"]()
        except ImportError:
            code = -1
    check(not runner.called, "missing coverage fails before launching the long agents runner")
    check(code == 2 and "agents/venv/bin/python" in error.getvalue(),
          "missing coverage gives an actionable interpreter preflight diagnostic")


def main() -> int:
    check_coverage_map_dependency_preflight()
    selector = sat.Selector()

    problems = sat.self_check(selector)
    for problem in problems[:50]:
        print(f"FAIL {problem}")
    check(not problems, f"self-check: every test file auto-mapped, every lane has an ALL fallback ({len(problems)} problems)")

    for trigger in ("back-end/prisma/schema.prisma", "package-lock.json", "scripts/run.sh"):
        sel = selector.select([trigger])
        check(sel.all_lanes, f"run_all trigger selects every lane: {trigger}")

    for trigger, lanes in (
        ("agents/requirements.txt", {"agents-blackbox", "agents-pytest", "cloudbench-controller"}),
        ("back-end/package.json", {"backend-blackbox", "backend-unit", "backend-structural"}),
        ("front-end/vite.config.ts", {"frontend-vitest", "mac-app-vitest"}),
    ):
        sel = selector.select([trigger])
        check(lanes <= sel.full_lanes, f"package config {trigger} runs its package lanes in full: {sorted(lanes)}")

    sel = selector.select(["agents/brand_new_module_nobody_imports.py"])
    check(sel.all_lanes, "unmapped/unknown file selects every lane")

    # no_tests exempts fallback; genuine/conservative dependencies still select.
    # Keep this inert fixture outside directories named by real source comments.
    sel = selector.select(["docs/selector-inert-fixture.md"])
    check(not sel.all_lanes and not any(sel.selected.values()), "declared-inert docs select nothing")

    # Upstream: a test that imports the changed module transitively is selected.
    sel = selector.select(["agents/tools/web_fetch.py"])
    check("workflow" in sel.selected["agents-blackbox"], "agents: transitive importer domain 'workflow' selected for tools/web_fetch.py")

    # Cross-package: front-end source reused by mac-app through the '@' alias.
    alias_hits = [
        f for f in sat.src().files
        if f.startswith("mac-app/tests/blackbox/") and "from '@/" in selector.graph.read(f)
    ]
    if alias_hits:
        test = alias_hits[0]
        deps = [d for d in selector.graph.deps.get(test, ()) if d.startswith("front-end/src/")]
        check(bool(deps), f"mac-app test resolves '@/' imports into front-end/src ({test})")
        if deps:
            sel = selector.select([deps[0]])
            check(test in sel.selected["mac-app-vitest"], f"front-end change {deps[0]} selects mac-app test {test}")

    # Cross-package HTTP: a backend router change selects blackbox domains that call its prefix.
    routers = getattr(selector.graph, "routers", {})
    check(bool(routers), "server.ts mounts were parsed into HTTP route resources")
    module = next(iter(routers.get("/api/waitlist", ())), None)
    if module:
        sel = selector.select([module])
        check("waitlist" in sel.selected["backend-blackbox"], f"router {module} selects backend blackbox 'waitlist'")
        check(len(sel.selected["backend-blackbox"]) < sel.totals["backend-blackbox"],
              "a single router change does not select every backend blackbox domain")

    # Structural gates are lane units, so this gate maps itself.
    sel = selector.select(["scripts/select_affected_tests.py"])
    check(sel.all_lanes, "changing the selector itself runs everything")

    print(f"select-affected-tests: {len(FAILURES)} failure(s)")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
