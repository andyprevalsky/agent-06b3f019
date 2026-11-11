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


def check_extraction_precision(selector: sat.Selector) -> None:
    """Comments and docstrings document; only code creates edges (never fewer code edges).

    Audit method when the strippers change (2026-10-31 review of 01bfbe386):
    strip every TS/JS file independently with esbuild (minify-whitespace keeps
    code, drops comments) and every Python file with ast/tokenize (docstring
    and COMMENT spans), then compare the path/import tokens each file yields
    against sat.strip_comments / sat._mask_python. Any token present only in
    the independent output is a potential under-inclusion; 0 were found over
    3,583 TS/JS and 1,298 Python files. Pair it with a before/after selection
    diff of every file (old selector vs new on the same tree) and trace the
    first missing edge of each lost lane unit to a comment/docstring line.
    """
    ts_files = ["x.test.ts", "docs/rca/cases/case.md", "scripts/critical.sh"]
    comment_only = (
        "/**\n * Start agent button is gated on ACTIVE (docs/rca/cases/\n * 2026-10-28-case.md).\n */\n"
        "const goal = `Reasoning identity ${name}`;\n"
        "// readFileSync('scripts/critical.sh') runs in parallel with models.blackbox.ts\n"
        "const re = /https?:\\/\\//; /* scripts/critical.sh */\n"
    )
    graph = sat.Graph(ts_files)
    graph.text["x.test.ts"] = comment_only
    graph.path_edges("x.test.ts")
    check("dir:docs/rca/cases" not in graph.data_deps["x.test.ts"]
          and "docs/rca/cases/case.md" not in graph.data_deps["x.test.ts"],
          "TS: a directory named only in a comment (file with template literals) is not a data edge")
    check("scripts/critical.sh" not in graph.deps["x.test.ts"] and "scripts/critical.sh" not in graph.data_deps["x.test.ts"],
          "TS: a script named only in line/block comments is not an edge")
    in_code = (
        "const goal = `Reasoning identity ${name}`;\n"
        "const cases = readdirSync('docs/rca/cases/');\n"
        "const text = readFileSync(`${root}/docs/rca/cases/case.md`);\n"
        "execFileSync('bash', ['scripts/critical.sh']);\n"
    )
    graph = sat.Graph(ts_files)
    graph.text["x.test.ts"] = in_code
    graph.path_edges("x.test.ts")
    check("dir:docs/rca/cases" in graph.data_deps["x.test.ts"], "TS: the same directory passed to a read in code is a data edge")
    check("docs/rca/cases/case.md" in graph.data_deps["x.test.ts"], "TS: a file path inside a template literal is a data edge")
    check("scripts/critical.sh" in graph.deps["x.test.ts"], "TS: a script named in executed code keeps its transitive edge")
    for uncertain in ("const s = \"unterminated // scripts/critical.sh\nrun();\n", "const t = `open // scripts/critical.sh\n"):
        check("scripts/critical.sh" in sat.strip_comments("x.test.ts", uncertain),
              "TS: an unterminated string/template keeps the raw source (over-select, never erase)")
    # Positive regex classification: escaped slashes inside a regex literal must
    # not be read as a `//` comment, including after `)` (`if (ok) /re/...`).
    regex_lines = (
        "const re = /https?:\\/\\//.test(s) && run('scripts/critical.sh');\n",
        "if (ok) /x\\//.test(s) && run('scripts/critical.sh');\n",
        "const r = [a, b].map(x => x / 2) / /\\/\\//.source.length + run('scripts/critical.sh');\n",
    )
    for source in regex_lines:
        check("scripts/critical.sh" in sat.strip_comments("x.test.ts", source),
              f"TS: a regex literal with escaped slashes keeps the code after it: {source.strip()[:60]}")
    with patch.object(sat, "_ts_regex_allowed", lambda *_: False):
        mutant = sat.strip_comments("x.test.ts", regex_lines[0])
    check("scripts/critical.sh" not in mutant,
          "TS: the regex assertions are load-bearing (a division-only mutant drops the edge)")
    # A division after `)`/`}` whose span reaches a template literal (PR #1656
    # review, 2026-10-31): read as a regex it swallowed the template opener and
    # flipped template state, so a `//` inside a LATER template (an https URL
    # naming a script) was erased as a line comment.
    for flipped in (
        "const s = (a) / 2 + `x/${b}`;\nconst u = `https://${host}/scripts/critical.sh`;\n",
        "const o = {}\n/ 2 + `y/${c}`;\nconst u = `https://${host}/scripts/critical.sh`;\n",
    ):
        check("scripts/critical.sh" in sat.strip_comments("x.test.ts", flipped),
              "TS: a division after `)`/`}` reaching a template literal keeps a path in a later template: "
              + flipped.splitlines()[0][:40])
    kept_regex = sat.strip_comments(
        "x.test.ts", "if (ok) /\\/\\/x/.test(s) && run('scripts/critical.sh'); // docs/rca/cases/case.md\n")
    check("/\\/\\/x/" in kept_regex and "scripts/critical.sh" in kept_regex and "docs/rca/cases/case.md" not in kept_regex,
          "TS: a genuine regex after `)` without a backtick is still a regex literal (kept; the trailing comment goes)")

    py_files = ["agents/tests/unit/test_x.py", "agents/helpers/llm.py", "agents/helpers/keep.py", "scripts/critical.sh"]
    documented = (
        '"""Example:\n    from helpers.llm import call_llm\n    importlib.import_module("helpers.llm")\n'
        '    bash scripts/critical.sh\n"""\n'
        "from helpers.keep import thing  # from helpers.llm import x\n"
        "def f():\n    r'''See \"helpers.llm\" and scripts/critical.sh'''\n    return thing\n"
    )
    graph = sat.Graph(py_files)
    graph.text["agents/tests/unit/test_x.py"] = documented
    graph.python_edges("agents/tests/unit/test_x.py")
    graph.path_edges("agents/tests/unit/test_x.py")
    deps = graph.deps["agents/tests/unit/test_x.py"]
    check("agents/helpers/llm.py" not in deps, "Python: a module named only in docstrings/comments is not an import edge")
    check("agents/helpers/keep.py" in deps, "Python: a real import next to a docstring keeps its edge")
    check("scripts/critical.sh" not in deps and "scripts/critical.sh" not in graph.data_deps["agents/tests/unit/test_x.py"],
          "Python: a script path named only in docstrings is not an edge")
    executed = (
        "import subprocess\nfrom helpers.llm import call_llm\n"
        'subprocess.run(["python3", "-c", """\nfrom helpers.keep import thing\n"""])\n'
        'subprocess.run(["bash", "scripts/critical.sh"])\n'
    )
    graph = sat.Graph(py_files)
    graph.text["agents/tests/unit/test_x.py"] = executed
    graph.python_edges("agents/tests/unit/test_x.py")
    graph.path_edges("agents/tests/unit/test_x.py")
    deps = graph.deps["agents/tests/unit/test_x.py"]
    check("agents/helpers/llm.py" in deps, "Python: a real import is an edge")
    check("agents/helpers/keep.py" in deps, "Python: an import inside a `python -c` source string (not a bare statement) is kept")
    check("scripts/critical.sh" in deps, "Python: a script path in a subprocess call keeps its edge")
    check("scripts/critical.sh" in sat.strip_comments("x.py", "s = \"unterminated scripts/critical.sh\n"),
          "Python: an unterminated string keeps the raw source")

    # Real-repo cases (2026-10-31 lane-scoped reuse vetoes): backend tests reached
    # a docs/rca case and an agents blackbox file only through header comments.
    sel = selector.select(["docs/rca/cases/2026-01-01-selector-precision-fixture.md"])
    check(not sel.all_lanes and not sel.selected["backend-blackbox"] and not sel.selected["backend-unit"],
          "a new docs/rca case selects no backend blackbox/unit test (directory named only in a comment)")
    sel = selector.select(["agents/tests/blackbox/rose_browser_use.blackbox.py"])
    check("rose-browser-use" in sel.selected["agents-blackbox"], "agents rose_browser_use blackbox selects its own domain")
    check(not sel.selected["backend-blackbox"],
          "agents rose_browser_use blackbox selects no backend blackbox domain (rose/models reached it only via comments)")
    # back-end/src/tests/unit/worker-process-deployment.test.ts names 'agents/tests' in
    # code (a fixture directory it creates); a code literal is never dropped.
    check(sel.selected["backend-unit"] <= {"back-end/src/tests/unit/worker-process-deployment.test.ts"},
          "agents rose_browser_use blackbox reaches backend-unit only through the code literal 'agents/tests'")

    # Every declared edge in scripts/test-map/edges.json still selects its targets.
    for edge in selector.config.get("edges", []):
        sample = next((f for f in sat.src().files if sat._match(f, edge["from"])), None)
        if sample is None:
            print(f"SKIP edges.json entry matches no file: {edge['from']}")
            continue
        sel = selector.select([sample])
        for lane, names in edge.get("to_lanes", {}).items():
            expected = {u.name for u in selector.lanes[lane].units if sat._match(u.name, names)}
            check(sel.all_lanes or expected <= sel.selected[lane],
                  f"edges.json: {sample} still selects {lane} {sorted(names)} ({len(expected)} unit(s))")
        for target in edge.get("to_files", []):
            expected = {(u.lane, u.name) for node in selector.upstream({target}) for u in selector.root_units.get(node, ())}
            check(sel.all_lanes or all(name in sel.selected[lane] for lane, name in expected),
                  f"edges.json: {sample} still selects the {len(expected)} unit(s) reading {target}")


def check_worker_provider_gate_reachability(selector: sat.Selector) -> None:
    owners = {
        "cloudbench-provider-contract": "scripts/tests/cloudbench-provider-contract.test.py",
        "worker-pool-cutover": "scripts/tests/worker-pool-cutover.test.py",
        "retained-agent-machine": "scripts/tests/retained-agent-machine.test.py",
    }
    units = {unit.name: unit for unit in selector.lanes["deploy-structural-gates"].units}
    for name, root in owners.items():
        check(name in units and units[name].roots == [root],
              f"provider/worker owning suite is a discovered deploy unit: {name}")
        check(name in selector.select([root]).selected["deploy-structural-gates"],
              f"provider/worker owning test selects its recurring gate: {name}")
    for path, expected in (
        ("scripts/run-bench-cloud", {"cloudbench-provider-contract"}),
        ("scripts/worker_pool_runtime.py", {"cloudbench-provider-contract", "worker-pool-cutover"}),
        ("scripts/retained_agent_machine.py", {"worker-pool-cutover", "retained-agent-machine"}),
    ):
        selected = selector.select([path]).selected["deploy-structural-gates"]
        reached = selector.upstream({path}, package_scans=False)
        direct = {unit.name for node in reached for unit in selector.root_units.get(node, [])
                  if unit.lane == "deploy-structural-gates"}
        check(expected <= selected and expected <= direct,
              f"actual dependency edges retain owning provider/worker gates for {path}")


def main() -> int:
    check_coverage_map_dependency_preflight()
    selector = sat.Selector()
    check_worker_provider_gate_reachability(selector)

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

    check_extraction_precision(selector)

    print(f"select-affected-tests: {len(FAILURES)} failure(s)")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
