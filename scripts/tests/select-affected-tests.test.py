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
import re
import json
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


def lanes_for(*paths: str) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = sat.main([arg for path in paths for arg in ("--lanes-for", path)])
    return code, out.getvalue()


def check_lanes_for() -> None:
    """`--lanes-for` answers from lane registration, never from reachability."""
    files = sat.src().files
    gate = "scripts/tests/select-affected-tests.test.py"
    code, out = lanes_for(gate)
    check(code == 0 and "deploy-structural-gates select-affected-tests" in out,
          f"--lanes-for: a registered deploy structural gate exits 0 and names its gate ({out.strip()})")
    for pattern, lane in (("back-end/src/tests/blackbox/*.blackbox.ts", "backend-blackbox"),
                          ("agents/tests/blackbox/*.blackbox.py", "agents-blackbox")):
        sample = sat.src().glob(pattern)[0]
        code, out = lanes_for(sample)
        check(code == 0 and f": {lane} " in out, f"--lanes-for: {lane} file {sample} exits 0 ({out.strip()})")
    code, out = lanes_for(str(sat.ROOT / gate))
    check(code == 0, "--lanes-for: an absolute path resolves to the repository file")

    # Suites run only by scripts/test.sh are not /deploy coverage.
    runner_only = [
        path for path in re.findall(r"^run_suite [^\n]*?\b(?:bash|python3) (scripts/tests/\S+)", sat.src().read("scripts/test.sh"), re.M)
        if path in sat.src().fileset and not sat.units_running(sat.discover_lanes(), path)
    ]
    for path in runner_only[:3]:
        code, out = lanes_for(path)
        check(code == 1 and "NOT RUN by any /deploy lane" in out, f"--lanes-for: {path} (scripts/test.sh only) exits 1")
    probe = "scripts/tests/zz-unregistered-probe.test.sh"
    with patch.object(sat.src(), "fileset", sat.src().fileset | {probe}):
        code, out = lanes_for(probe, gate)
    check(code == 1 and "NOT RUN by any /deploy lane" in out, "--lanes-for: an unregistered test exits 1, also beside a registered one")
    # Negative control: the selector is imported by a registered gate (reachable), but no lane runs it.
    code, out = lanes_for("scripts/select_affected_tests.py")
    check(code == 1, "--lanes-for: a file a lane unit only imports or reads is not reported as run")
    code, out = lanes_for("scripts/tests/zz-missing-probe.test.sh")
    check(code == 2 and "not a file" in out, "--lanes-for: a missing path exits 2")

    # Gate runners that discover suites by their own glob: the glob must still be in the runner.
    for name, (runner, pattern) in sat.RUNNER_GLOBS.items():
        text = sat.src().read(runner)
        check(pattern in text or pattern.split("/", 1)[1] in text, f"RUNNER_GLOBS: {runner} still runs {pattern}")
        suites = sat.src().glob(pattern)
        check(bool(suites) and all(lanes_for(path)[1].count(f"deploy-structural-gates {name}") == 1 for path in suites),
              f"--lanes-for: every {pattern} suite is run by gate {name} ({len(suites)} files)")
def check_new_test_stability() -> None:
    """The five-consecutive-run rule for new tests: every run under owned CPU load."""
    import os
    import tempfile
    import time

    with tempfile.TemporaryDirectory(prefix="new-test-stability-") as tmp:
        work = Path(tmp)
        lanes = {"deploy-structural-gates": sat.Lane("deploy-structural-gates", [
            sat.Unit("deploy-structural-gates", "fixture", ["scripts/tests/fixture.test.py", "scripts/helper.py"])])}
        real = work / "real.test.py"
        real.write_text("x")
        original_root = sat.ROOT
        sat.ROOT = work
        try:
            (work / "scripts/tests").mkdir(parents=True)
            (work / "scripts/tests/fixture.test.py").write_text("x")
            picked = sat.new_test_units(["scripts/tests/fixture.test.py"], lanes)
            check([u.name for u in picked] == ["fixture"], "stability: a changed test file selects its own unit")
            check(sat.new_test_units(["scripts/helper.py"], lanes) == [],
                  "stability: a changed non-test root is not a new test")
            check(sat.new_test_units(["scripts/tests/deleted.test.py"], lanes) == [],
                  "stability: a deleted test file selects nothing")
        finally:
            sat.ROOT = original_root

        def unit(script: Path, *args: str) -> "sat.Unit":
            return sat.Unit("cloudbench-controller", " ".join([sys.executable, str(script), *args]), [str(script)])

        observe = work / "observe.py"
        observe.write_text(
            "import subprocess, sys\n"
            "rows = subprocess.run(['ps', '-eo', 'ppid=,args='], capture_output=True, text=True).stdout\n"
            "n = sum(1 for r in rows.splitlines() if r.split(None, 1)[0] == sys.argv[1] and 'os.getppid() == parent' in r)\n"
            "open(sys.argv[2], 'a').write(f'{n}\\n')\n"
        )
        seen = work / "seen.txt"
        report = sat.run_stability([unit(observe, str(os.getpid()), str(seen))], load_workers=3, timeout=60,
                                   log_root=work / "logs-pass")
        counts = seen.read_text().split()
        check(report["status"] == "PASS" and counts == ["2"] * 5,
              f"stability: five consecutive passes, the unit's lane plus exactly 2 owned workers fill 3 slots ({counts})")
        row = next(iter(report["units"].values()))
        check(row["cases"] == [sat.WHOLE_UNIT] and row["wall_seconds"] >= sum(a["seconds"] for a in row["attempts"]) - 0.5
              and report["wall_seconds"] >= row["wall_seconds"],
              "stability: the report names the rerun scope and per-unit/total wall time")
        time.sleep(0.2)
        leaked = []
        for pid in report["load"]["pids"]:
            try:
                os.kill(pid, 0)
                leaked.append(pid)
            except ProcessLookupError:
                pass
        check(len(report["load"]["pids"]) == 4 and not leaked,
              f"stability: every load worker (3 initial, 1 top-up) reaped by exact PID ({leaked})")

        flaky = work / "flaky.py"
        flaky.write_text("import sys\nfrom pathlib import Path\np = Path(sys.argv[1])\nn = int(p.read_text() or 0) + 1 "
                         "if p.exists() else 1\np.write_text(str(n))\nsys.exit(1 if n == 3 else 0)\n")
        report = sat.run_stability([unit(flaky, str(work / "count"))], load_workers=1, timeout=60,
                                   log_root=work / "logs-flaky")
        row = next(iter(report["units"].values()))
        check(report["status"] == "FAIL" and row["consecutive_passes"] == 2 and len(row["attempts"]) == 3,
              "stability: a third-run failure fails the check and stops the streak")
        # A reader of the gate artifact must find the failing run's log from the unit name alone
        # (2026-11-08: browser-tilion's run-3 log sat in `001-run3.log`, unnamed and unreferenced).
        failing_log = Path(row["attempts"][-1]["log"])
        summary_path = work / "logs-flaky" / "summary.json"
        summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}
        check(failing_log.exists() and "flaky" in failing_log.name and failing_log.name.endswith("-run3.log")
              and summary.get("units", {}).get(next(iter(report["units"])), {}).get("attempts", [{}])[-1].get("log")
              == str(failing_log),
              f"stability: the failing run's log is named for its unit and indexed in log_root/summary.json ({failing_log.name})")
        printed = io.StringIO()
        real_run = sat.run_stability
        with patch.object(sat, "new_test_units", return_value=[unit(flaky, str(work / "count-cli"))]), \
                patch.object(sat, "run_stability", lambda *a, **k: real_run(*a, **{**k, "log_root": work / "logs-cli"})), \
                contextlib.redirect_stdout(printed):
            code = sat.main(["--stability", "--changed-file", "x.test.py", "--load-workers", "1"])
        cli_row = json.loads((work / "logs-cli" / "summary.json").read_text())["units"]
        cli_log = next(iter(cli_row.values()))["attempts"][-1]["log"]
        check(code == 1 and f"log {cli_log}" in printed.getvalue(),
              "stability: the report prints the failing run's log path under its FAIL row")
        vanish = work / "vanish.py"
        vanish.write_text("import shutil, sys\nshutil.rmtree(sys.argv[1], ignore_errors=True)\n")
        report = sat.run_stability([unit(vanish, str(work / "logs-vanish"))], load_workers=1, timeout=60,
                                   log_root=work / "logs-vanish")
        check(report["status"] == "UNVERIFIED" and "deleted" in next(iter(report["units"].values())).get("reason", ""),
              "stability: a run whose logs were deleted mid-check is UNVERIFIED, never a PASS without evidence")

        leaky = work / "leaky.py"
        leaky.write_text("import json, os\n"
                         "path = os.environ.get('DEPLOY_GATE_PROGRESS')\n"
                         "if path:\n"
                         "    open(path, 'a').write(json.dumps({'v': 1, 'scope': 'test', 'case': 'first', 'unit': 'fixture-row',"
                         " 'status': 'FAIL', 'at': 1.0, 'detail': '', 'log': ''}) + '\\n')\n")
        gate_rows = work / "gate-progress.jsonl"
        saved = {k: os.environ.get(k) for k in ("DEPLOY_GATE_PROGRESS", "DEPLOY_GATE_CASE")}
        os.environ.update({"DEPLOY_GATE_PROGRESS": str(gate_rows), "DEPLOY_GATE_CASE": "new-test-stability"})
        try:
            report = sat.run_stability([unit(leaky)], load_workers=1, timeout=60, log_root=work / "logs-leaky")
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        leaked_rows = gate_rows.read_text() if gate_rows.exists() else ""
        check(report["status"] == "PASS" and "fixture-row" not in leaked_rows,
              "stability: a rerun test never writes into the gate's own progress channel")

        mutate = work / "mutate.py"
        mutate.write_text("import sys\nopen(sys.argv[0], 'a').write('\\n')\n")
        report = sat.run_stability([unit(mutate)], load_workers=1, timeout=60, log_root=work / "logs-mutate")
        check(report["status"] == "UNVERIFIED", "stability: test code changed during the runs is UNVERIFIED, not PASS")

        hang = work / "hang.py"
        hang.write_text("import time\ntime.sleep(60)\n")
        report = sat.run_stability([unit(hang)], load_workers=1, timeout=1, log_root=work / "logs-hang")
        row = next(iter(report["units"].values()))
        check(report["status"] == "FAIL" and row["attempts"][0]["exit"] is None, "stability: a timed-out run fails")

        report = sat.run_stability([sat.Unit("unknown-lane", "x.test.ts", [str(real)])], load_workers=1,
                                   log_root=work / "logs-unsupported")
        check(report["status"] == "UNVERIFIED" and next(iter(report["units"].values()))["status"] == "UNSUPPORTED",
              "stability: a lane without a runner is UNSUPPORTED, never PASS")

        with sat.CpuLoad(1, 60) as load:
            alive = load.alive()
            load.procs[0].terminate()
            load.procs[0].wait()
            check(alive and not load.alive(), "stability: a dead load worker means the run was not under load")
        try:
            sat.run_stability([], runs=4, load_workers=1, log_root=work / "logs-short")
            check(False, "stability: fewer than five runs is refused")
        except ValueError:
            check(True, "stability: fewer than five runs is refused")


def check_stability_concurrency() -> None:
    """Units run concurrently; lanes + owned busy workers fill every load slot; runs stay consecutive."""
    import os
    import tempfile
    import time

    with tempfile.TemporaryDirectory(prefix="new-test-stability-lanes-") as tmp:
        work = Path(tmp)
        observe = work / "lane.py"
        # Run 1 of every unit waits until all three units have started: at that moment every
        # lane holds its slot, so exactly slots - 3 busy workers may be running.
        observe.write_text(
            "import os, subprocess, sys, time\n"
            "parent, marks, name, units = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])\n"
            "start = time.time()\n"
            "first = not os.path.exists(os.path.join(marks, name))\n"
            "open(os.path.join(marks, name), 'a').close()\n"
            "deadline = time.time() + 20\n"
            "while first and len([m for m in os.listdir(marks) if not m.endswith('.log')]) < units and time.time() < deadline:\n"
            "    time.sleep(0.02)\n"
            "rows = subprocess.run(['ps', '-eo', 'ppid=,args='], capture_output=True, text=True).stdout\n"
            "n = sum(1 for r in rows.splitlines() if r.split(None, 1)[0] == parent and 'os.getppid() == parent' in r)\n"
            "time.sleep(0.05)\n"
            "open(os.path.join(marks, name + '.log'), 'a').write(f'{int(first)} {n} {start} {time.time()}\\n')\n"
        )
        marks = work / "marks"
        marks.mkdir()

        def lane(name: str, units: int) -> "sat.Unit":
            command = [sys.executable, str(observe), str(os.getpid()), str(marks), name, str(units)]
            return sat.Unit("cloudbench-controller", " ".join(command), [str(observe)])

        report = sat.run_stability([lane(n, 3) for n in ("a", "b", "c")], load_workers=4, timeout=60,
                                   log_root=work / "logs-lanes")
        rows = {n: [line.split() for line in (marks / f"{n}.log").read_text().splitlines()] for n in "abc"}
        firsts = [int(r[1]) for n in "abc" for r in rows[n] if r[0] == "1"]
        check(report["status"] == "PASS" and report["load"]["lanes"] == 4 and firsts == [1, 1, 1],
              f"stability: three concurrent units hold 3 of 4 slots, exactly 1 busy worker fills the rest ({firsts})")
        every = [int(r[1]) for n in "abc" for r in rows[n]]
        check(all(1 <= n <= 3 for n in every), f"stability: lanes + busy workers always fill all 4 slots ({every})")
        spans = {n: [(float(r[2]), float(r[3])) for r in rows[n]] for n in "abc"}
        consecutive = all(len(s) == 5 and all(s[i][1] <= s[i + 1][0] for i in range(4)) for s in spans.values())
        overlap = spans["a"][0][0] < spans["b"][0][1] and spans["b"][0][0] < spans["a"][0][1]
        check(consecutive and overlap, "stability: each unit's five runs are consecutive while different units overlap")
        leaked = []
        for pid in report["load"]["pids"]:
            try:
                os.kill(pid, 0)
                leaked.append(pid)
            except ProcessLookupError:
                pass
        check(len(report["load"]["pids"]) >= 4 and not leaked,
              f"stability: initial and top-up load workers all reaped by exact PID ({leaked})")

        for path in marks.iterdir():
            path.unlink()
        report = sat.run_stability([lane(n, 1) for n in ("d", "e")], load_workers=3, lanes=1, timeout=60,
                                   log_root=work / "logs-serial")
        d = [(float(r[2]), float(r[3]), int(r[1])) for r in (line.split() for line in (marks / "d.log").read_text().splitlines())]
        e = [(float(r[2]), float(r[3]), int(r[1])) for r in (line.split() for line in (marks / "e.log").read_text().splitlines())]
        apart = d[-1][1] <= e[0][0] or e[-1][1] <= d[0][0]
        check(report["status"] == "PASS" and apart and {x[2] for x in d + e} == {2},
              "stability: --stability-lanes 1 runs units one at a time with slots - 1 busy workers")

        # A TERM to the check (gate timeout/cancel) reaps the running unit's session and the load.
        hang = work / "hang.py"
        hang.write_text("import os, sys, time\nopen(sys.argv[1], 'w').write(str(os.getpid()))\ntime.sleep(120)\n")
        pidfile = work / "hang.pid"
        driver = (
            "import signal, sys\nfrom pathlib import Path\n"
            f"sys.path.insert(0, {str(ROOT / 'scripts')!r})\n"
            "import select_affected_tests as sat\n"
            "signal.signal(signal.SIGTERM, sat._terminate)\n"
            f"unit = sat.Unit('cloudbench-controller', {sys.executable + ' ' + str(hang) + ' ' + str(pidfile)!r}, [{str(hang)!r}])\n"
            f"sat.run_stability([unit], load_workers=2, timeout=120, log_root=Path({str(work / 'logs-term')!r}))\n"
        )
        import subprocess
        proc = subprocess.Popen([sys.executable, "-c", driver])
        sys.path.insert(0, str(ROOT / "scripts" / "lib"))
        from condition_wait import wait_until
        wait_until(lambda: pidfile.exists() and pidfile.read_text(), timeout=30, description="the hung unit started")
        child = int(pidfile.read_text())
        proc.terminate()
        code = proc.wait(timeout=30)
        try:
            os.kill(child, 0)
            alive = True
        except ProcessLookupError:
            alive = False
        workers = subprocess.run(["ps", "-eo", "ppid=,args="], capture_output=True, text=True).stdout
        orphans = [r for r in workers.splitlines() if "getppid" in r and r.rstrip().endswith(f" {proc.pid}")]
        check(child > 0 and code == 143 and not alive and not orphans,
              f"stability: TERM reaps the running unit's session and the owned load (exit {code}, child alive {alive})")

        with sat.CpuLoad(4, 60) as load:
            load.take()
            load.take()
            two = len(load.procs)
            load.give()
            three = len(load.procs)
            check(two == 2 and three == 3 and load.alive(), "stability: take/give move one slot between a lane and a worker")
            load.procs[0].terminate()
            load.procs[0].wait()
            check(not load.alive(), "stability: an empty slot (dead worker) is not under load")

        # Exclusive groups (Gate.exclusive) never overlap; other units still run beside them.
        for path in marks.iterdir():
            path.unlink()
        gates = [(n, [sys.executable, str(observe), str(os.getpid()), str(marks), n, "1"]) for n in ("x1", "x2", "free")]
        options = {"x1": {"exclusive": "GROUP"}, "x2": {"exclusive": "GROUP"}, "free": {}}
        units = [sat.Unit("deploy-structural-gates", n, [str(observe)]) for n, _ in gates]
        with patch.object(sat, "_structural_gates", return_value=gates), \
                patch.object(sat, "_structural_gate_options", return_value=options):
            report = sat.run_stability(units, load_workers=4, timeout=60, log_root=work / "logs-exclusive")
        span = {n: [(float(r[2]), float(r[3])) for r in (line.split() for line in (marks / f"{n}.log").read_text().splitlines())]
                for n in ("x1", "x2", "free")}
        apart = span["x1"][-1][1] <= span["x2"][0][0] or span["x2"][-1][1] <= span["x1"][0][0]
        beside = any(a[0] < b[1] and b[0] < a[1] for a in span["free"] for b in span["x1"] + span["x2"])
        check(report["status"] == "PASS" and apart and beside,
              "stability: units sharing an exclusive group never overlap; others run beside them")


CASE_FIXTURE = '''import os
import unittest

LOG = os.environ["CASE_LOG"]


def record(name):
    open(LOG, "a").write(name + "\\n")


class Alpha(unittest.TestCase):
    def setUp(self):
        self.value = 1

    def test_one(self):
        record("Alpha.test_one")

    def test_two(self):
        record("Alpha.test_two")


class Beta(unittest.TestCase):
    def test_three(self):
        record("Beta.test_three")


if __name__ == "__main__":
    unittest.main()
'''


def check_stability_case_selection() -> None:
    """Only added/changed cases rerun; anything outside a case widens the scope (never narrows it)."""
    import os
    import subprocess
    import tempfile

    added, removed = sat.parse_unified_zero("@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-x\n+y\n@@ -20,2 +21,0 @@\n-p\n-q\n")
    check(added == {4, 5, 12} and removed == {10, 20, 21}, f"stability: -U0 hunks map to new/old line numbers ({added}, {removed})")

    base = CASE_FIXTURE

    def pick(new: str, old: str = base) -> list[str] | None:
        old_lines = old.split("\n")
        new_lines = new.split("\n")
        import difflib
        add: set[int] = set()
        rem: set[int] = set()
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes():
            if tag != "equal":
                rem.update(range(i1 + 1, i2 + 1))
                add.update(range(j1 + 1, j2 + 1))
        changes = sat.LineChanges(add, rem, old, new)
        return sat.changed_cases(sat.python_test_cases(new, "unittest"), sat.python_test_cases(old, "unittest"), changes)

    edited = base.replace('record("Alpha.test_two")', 'record("Alpha.test_two")\n        self.assertTrue(True)')
    check(pick(edited) == ["Alpha.test_two"], f"stability: a line changed inside a test method reruns only it ({pick(edited)})")
    new_test = base.replace("\n\nif __name__", "\n    def test_four(self):\n        record('Beta.test_four')\n\n\nif __name__")
    check(pick(new_test) == ["Beta.test_four"], f"stability: a new test method (with its blank separator) reruns only it ({pick(new_test)})")
    setup = base.replace("self.value = 1", "self.value = 2")
    check(pick(setup) == ["Alpha"], f"stability: a setUp/helper change reruns its whole class ({pick(setup)})")
    both = setup.replace('record("Alpha.test_one")', 'record("Alpha.test_one") ')
    check(pick(both) == ["Alpha"], "stability: a selected class subsumes its own changed methods")
    module = base.replace('LOG = os.environ["CASE_LOG"]', 'LOG = os.environ.get("CASE_LOG")')
    check(pick(module) is None, "stability: a module-level change reruns the whole unit")
    imported = base.replace("import os\n", "import os\nimport json\n")
    check(pick(imported) is None, "stability: an added import reruns the whole unit")
    comment = edited.replace("class Beta(", "# Beta covers the third case.\nclass Beta(")
    check(pick(comment) == ["Alpha.test_two"], "stability: a module-level comment does not widen the scope")
    removed_line = base.replace('        record("Beta.test_three")\n', '        pass\n')
    check(pick(removed_line) == ["Beta.test_three"], "stability: a removed line of a surviving case reruns that case")
    deleted = base.replace('    def test_two(self):\n        record("Alpha.test_two")\n\n', "")
    check(pick(deleted) is None, "stability: deleting a test alone still reruns the unit (never certifies nothing)")
    deleted_and_edit = deleted.replace('record("Beta.test_three")', 'record("Beta.test_three")  # x')
    check(pick(deleted_and_edit) == ["Beta.test_three"], "stability: a deleted test needs no rerun; the edited one does")
    sub = base.replace("class Beta(unittest.TestCase):", "class Beta(Alpha):")
    sub_setup = sub.replace("self.value = 1", "self.value = 3")
    check(pick(sub_setup, sub) is None, "stability: a change in a subclassed class reruns the whole unit")
    used = base.replace("\n\nif __name__", "\n\nHELPER = Alpha\n\n\nif __name__")
    check(pick(used.replace("self.value = 1", "self.value = 4"), used) is None,
          "stability: a class referenced elsewhere in the module is not addressable")
    check(sat.python_test_cases(base.replace("unittest.main()", "sys.exit(main())"), "unittest") is None,
          "stability: a script without unittest.main() cannot take case ids")
    check(sat.python_test_cases(base.replace("import os\n", "import os\nimport sys\nMODE = sys.argv[-1]\n"), "unittest") is None,
          "stability: a module that reads sys.argv cannot take case ids")
    check(sat.python_test_cases(base.replace("unittest.main()", "unittest.main(argv=['x'])"), "unittest") is None,
          "stability: unittest.main(argv=...) ignores appended ids")
    pytest_src = "import pytest\n\n\ndef test_a():\n    assert 1\n\n\nclass TestB:\n    def test_c(self):\n        assert 1\n"
    ids = [c for c, _, _ in sat.python_test_cases(pytest_src, "pytest", "tests/unit/test_x.py").cases]
    check(ids == ["tests/unit/test_x.py::TestB::test_c", "tests/unit/test_x.py::test_a"], f"stability: pytest node ids ({ids})")

    with tempfile.TemporaryDirectory(prefix="new-test-stability-cases-") as tmp:
        repo = Path(tmp)
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
               "GIT_COMMITTER_EMAIL": "t@t"}

        def git(*args: str) -> None:
            subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, env=env)

        test = "scripts/tests/cases.test.py"
        (repo / "scripts/tests").mkdir(parents=True)
        (repo / test).write_text(base)
        git("init", "-q")
        git("add", "-A")
        git("commit", "-qm", "base")
        git("update-ref", "refs/remotes/origin/main", "HEAD")
        (repo / test).write_text(edited)
        log = repo / "cases.log"
        original_root = sat.ROOT
        sat.ROOT = repo
        saved = os.environ.get("CASE_LOG")
        os.environ["CASE_LOG"] = str(log)
        try:
            unit = sat.Unit("cloudbench-controller", f"{sys.executable} {test}", [test])
            changes = sat.line_changes(test, None, None)
            check(changes is not None and changes.added == {20}, f"stability: worktree lines diff against the merge base ({changes and changes.added})")
            report = sat.run_stability([unit], load_workers=2, timeout=60, log_root=repo / "logs-case", changed=[test],
                                       diff=lambda path: sat.line_changes(path, None, None))
            row = next(iter(report["units"].values()))
            ran = log.read_text().split()
            check(report["status"] == "PASS" and row["cases"] == ["Alpha.test_two"] and ran == ["Alpha.test_two"] * 5,
                  f"stability: only the changed case ran, five consecutive times ({row.get('cases')}, {ran})")
            log.unlink()
            (repo / test).write_text(module)
            report = sat.run_stability([unit], load_workers=2, timeout=60, log_root=repo / "logs-whole", changed=[test],
                                       diff=lambda path: sat.line_changes(path, None, None))
            row = next(iter(report["units"].values()))
            ran = sorted(set(log.read_text().split()))
            check(report["status"] == "PASS" and row["cases"] == [sat.WHOLE_UNIT] and len(log.read_text().split()) == 15
                  and ran == ["Alpha.test_one", "Alpha.test_two", "Beta.test_three"],
                  "stability: a module-level change reruns every case of the unit five times")
            fresh = "scripts/tests/fresh.test.py"
            (repo / fresh).write_text(base)
            plan = sat.plan_unit(sat.Unit("cloudbench-controller", f"{sys.executable} {fresh}", [fresh]), [fresh],
                                 lambda path: sat.line_changes(path, None, None))
            check(plan is not None and plan.cases == [sat.WHOLE_UNIT], "stability: a new test file reruns its whole unit")
            plan = sat.plan_unit(unit, [test], None)
            check(plan is not None and plan.cases == [sat.WHOLE_UNIT], "stability: no diff information reruns the whole unit")
            (repo / test).write_text(edited)
            git("add", "-A")
            git("commit", "-qm", "head")
            (repo / test).write_text(setup)
            check(sat.line_changes(test, "origin/main", "HEAD") is None,
                  "stability: --head line info is refused when the worktree is not that revision")
        finally:
            sat.ROOT = original_root
            if saved is None:
                os.environ.pop("CASE_LOG", None)
            else:
                os.environ["CASE_LOG"] = saved


BLACKBOX_FIXTURE = '''from _test_utils import BlackboxResult


def _helper():
    return 1


def test_one():
    assert _helper() == 1


def test_two():
    assert True


def test_shared():
    assert True


def test_caller():
    test_shared()


async def run_all_tests():
    r = BlackboxResult()
    r.record("one", test_one)
    r.record(
        "two",
        test_two,
    )
    r.record("shared", test_shared)
    r.record("caller", test_caller)
    return r.all_passed
'''


def check_stability_blackbox_cases() -> None:
    """Agents blackbox domains narrow to changed test functions via BLACKBOX_CASE_FUNCTIONS."""
    import os
    import tempfile

    base = BLACKBOX_FIXTURE

    def pick(new: str, old: str = base) -> list[str] | None:
        import difflib
        add: set[int] = set()
        rem: set[int] = set()
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old.split("\n"), new.split("\n"), autojunk=False).get_opcodes():
            if tag != "equal":
                rem.update(range(i1 + 1, i2 + 1))
                add.update(range(j1 + 1, j2 + 1))
        return sat.changed_cases(sat.blackbox_test_cases(new), sat.blackbox_test_cases(old), sat.LineChanges(add, rem, old, new))

    check(pick(base.replace("assert True\n\n\ndef test_shared", "assert 1 == 1\n\n\ndef test_shared")) == ["test_two"],
          "blackbox stability: a changed registered test function is selected")
    added = base.replace("\n\nasync def run_all_tests", "\n\ndef test_new():\n    assert True\n\n\nasync def run_all_tests").replace(
        "    return r.all_passed", '    r.record("new", test_new)\n    return r.all_passed')
    check(pick(added) == ["test_new"], f"blackbox stability: a new function plus its registration selects only it ({pick(added)})")
    check(pick(base.replace("return 1", "return 2")) is None, "blackbox stability: a helper change reruns the whole domain")
    check(pick(base.replace("from _test_utils import BlackboxResult", "from _test_utils import BlackboxResult, teardown_mock")) is None,
          "blackbox stability: a module-level change reruns the whole domain")
    shared = base.replace("def test_shared():\n    assert True", "def test_shared():\n    assert 2 > 1")
    check(pick(shared) is None, "blackbox stability: a test another case calls is not addressable (whole domain)")
    check(pick(base.replace('r.record("caller", test_caller)', 'r.record("caller", test_caller)\n    print("x")')) is None,
          "blackbox stability: other run_all_tests changes rerun the whole domain")
    check(sat.blackbox_test_cases(base.replace("r = BlackboxResult()", "r = object()")) is None,
          "blackbox stability: a domain without BlackboxResult cannot take the filter")

    # The real benchmark domain: a changed registered test function becomes the filter.
    domain = "agents/tests/blackbox/benchmark.blackbox.py"
    source = (ROOT / domain).read_text()
    cases = sat.blackbox_test_cases(source)
    target = next(c for c in (cases.cases if cases else []) if c[0] == "test_history_ledger_task_names_still_exist_in_catalog")
    unit = sat.Unit("agents-blackbox", "benchmark", [domain])
    plan = sat.plan_unit(unit, [domain], lambda path: sat.LineChanges({target[1] + 1}, set(), source, source))
    check(plan is not None and plan.env == {sat.BLACKBOX_CASE_FILTER_ENV: target[0]} and plan.receipt
          and plan.cases == [target[0]], f"blackbox stability: benchmark passes the filter for its changed function ({plan and plan.env})")
    helper = next(n for n in __import__("ast").parse(source).body if getattr(n, "name", "") == "_run_benchmark_subprocess_and_judge_cases")
    plan = sat.plan_unit(unit, [domain], lambda path: sat.LineChanges({helper.lineno + 1}, set(), source, source))
    check(plan is not None and plan.cases == [sat.WHOLE_UNIT] and not plan.env,
          "blackbox stability: a benchmark helper change reruns the whole domain without a filter")

    saved = {k: os.environ.get(k) for k in sat.CASE_FILTER_ENV}
    os.environ[sat.BLACKBOX_CASE_FILTER_ENV] = "test_x"
    try:
        check(sat.BLACKBOX_CASE_FILTER_ENV not in sat.stability_environment(),
              "blackbox stability: a whole-unit rerun never inherits a case filter")
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    with tempfile.TemporaryDirectory(prefix="new-test-stability-receipt-") as tmp:
        work = Path(tmp)
        script = work / "case.py"
        script.write_text("import os\nwanted = os.environ['BLACKBOX_CASE_FUNCTIONS'].split(',')\n"
                          "skip = os.environ.get('SKIP_CASE', '')\n"
                          "open(os.environ['BLACKBOX_CASE_RECEIPT'], 'a').write(''.join(f'{w}\\n' for w in wanted if w != skip))\n")

        def plan_for(skip: str) -> "sat.StabilityPlan":
            return sat.StabilityPlan("agents-blackbox:fixture", [sys.executable, str(script)], work, ["test_a", "test_b"],
                                     "changed cases", env={sat.BLACKBOX_CASE_FILTER_ENV: "test_a,test_b", "SKIP_CASE": skip},
                                     receipt=True)

        with sat.CpuLoad(2, 60) as load:
            ran = sat._run_plan(0, plan_for(""), 5, 60, work, load)
            missing = sat._run_plan(1, plan_for("test_b"), 5, 60, work, load)
        check(ran["status"] == "PASS" and ran["consecutive_passes"] == 5,
              "blackbox stability: five filtered runs whose receipts name every selected case pass")
        check(missing["status"] == "FAIL" and missing["attempts"][0]["missing_cases"] == ["test_b"]
              and "test_b" in missing["reason"],
              "blackbox stability: a filtered run that skipped a selected case fails, never passes")


def check_stability_backend_lanes() -> None:
    """Backend lanes run with their own runner and a private local database; mac-app off Darwin is omitted."""
    import os
    import tempfile
    lanes = sat.discover_lanes()
    structural = next(u for u in lanes["backend-structural"].units if u.name == "layer-deps.test.ts")
    command, cwd = sat.stability_command(structural)
    check(command == ["npx", "tsx", "src/tests/structural/layer-deps.test.ts"] and cwd == sat.ROOT / "back-end",
          f"stability: a backend structural unit runs its own package step with tsx from back-end ({command})")
    shell = next((u for u in lanes["backend-structural"].units if u.name.endswith(".sh")), None)
    if shell:
        command, _ = sat.stability_command(shell)
        check(command[0] == "bash" and command[-1].endswith(shell.name),
              f"stability: a backend structural shell step keeps its bash command ({command})")
    plan = sat.plan_unit(structural, list(structural.roots), None)
    check(plan is not None and not plan.databases and sat.isolate_plan(plan, structural, 0).databases == [],
          "stability: a backend structural unit needs no database")

    blackbox = sat.Unit("backend-blackbox", "phone-hold", ["back-end/src/tests/blackbox/phone-hold.blackbox.ts"])
    plan = sat.isolate_plan(sat.plan_unit(blackbox, list(blackbox.roots), None), blackbox, 3,
                            server="postgresql://postgres:postgres@localhost:5432")
    identity = plan.env.get("CONDUCTOR_WORKSPACE_NAME", "")
    check(plan.command == ["bash", "scripts/run-blackbox-tests.sh", "phone-hold"] and plan.cwd == sat.ROOT / "back-end"
          and identity.startswith(f"stab-{os.getpid()}-3-") and plan.env["ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME"] == "1"
          and plan.env[sat.STABILITY_IDENTITY_ENV] == "1"
          and plan.env["BLACKBOX_TEST_DATABASE_URL"] == f"postgresql://postgres:postgres@localhost:5432/victoria_{identity}"
          and plan.databases == [f"victoria_{identity}"] and plan.prepare == [],
          f"stability: a backend blackbox domain runs its runner on its own victoria_<identity> database ({plan.env})")
    other = sat.isolate_plan(sat.plan_unit(blackbox, list(blackbox.roots), None), blackbox, 4,
                             server="postgresql://postgres:postgres@localhost:5432")
    check(other.databases != plan.databases
          and other.env["BLACKBOX_TEST_BACKEND_START_PORT"] != plan.env["BLACKBOX_TEST_BACKEND_START_PORT"],
          "stability: concurrent blackbox units get distinct databases and backend start ports")
    check({"BLACKBOX_TEST_RUN_ID", "BLACKBOX_TEST_ARTIFACT_DIR", "BLACKBOX_TEST_BACKEND_PORT", "TEST_BASE_URL",
           "ROSE_TEST_DB_LOCK_INHERITED_KEY"} <= set(plan.unset),
          "stability: a blackbox unit never inherits a shared run id, artifact dir, port, backend or lock")

    unit_file = sat.Unit("backend-unit", "back-end/src/tests/unit/sub/x.test.ts", ["back-end/src/tests/unit/sub/x.test.ts"])
    plan = sat.isolate_plan(sat.plan_unit(unit_file, list(unit_file.roots), None), unit_file, 0,
                            server="postgresql://postgres:postgres@127.0.0.1:5432")
    url = plan.env.get("BACKEND_UNIT_DATABASE_URL", "")
    check(plan.command == ["npx", "tsx", "scripts/run-unit-tests.ts"] and plan.env["BACKEND_UNIT_TEST_FILES"] == "sub/x.test.ts"
          and url.startswith("postgresql://postgres:postgres@127.0.0.1:5432/victoria_stab-")
          and all(plan.env[k] == url for k in ("DATABASE_URL", "DIRECT_URL", "DIRECT_DATABASE_URL"))
          and plan.databases == [url.rsplit("/", 1)[1]] and "BACKEND_UNIT_ALLOW_REMOTE_DB" in plan.unset
          and plan.prepare and "prisma:push:local" in plan.prepare[0],
          f"stability: a backend unit file runs alone on its own pushed local database ({plan.env})")
    for remote in ("postgresql://u:p@db.example.supabase.co:5432", "postgresql://u:p@localhost:5432?host=evil.example"):
        try:
            sat.isolate_plan(sat.plan_unit(unit_file, list(unit_file.roots), None), unit_file, 0, server=remote)
            check(False, f"stability: the unit lane refuses a non-localhost database server ({remote})")
        except ValueError:
            check(True, f"stability: the unit lane refuses a non-localhost database server ({remote})")
    # The second line of defence: an env that reaches the runner with a remote URL never runs or creates anything.
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        bad = sat.StabilityPlan("backend-unit:x", [sys.executable, "-c", "open('ran','w')"], work, [sat.WHOLE_UNIT], "t",
                                env={"BACKEND_UNIT_DATABASE_URL": "postgresql://u:p@remote.example:5432/victoria_x"},
                                databases=["victoria_x"], server="postgresql://postgres:postgres@localhost:5432")
        with patch.object(sat, "_psql", side_effect=AssertionError("must not touch Postgres")):
            row = sat._run_plan(0, bad, 5, 60, work, sat.CpuLoad(0, 60))
        check(row["status"] == "UNVERIFIED" and "not a localhost" in row.get("reason", "") and not row["attempts"]
              and not (work / "ran").exists() and row["databases"]["created"] == [],
              "stability: a unit whose database URL is remote is refused before any run or database change")

        # Setup and teardown touch exactly the owned name; teardown runs after a failing unit too.
        calls: list[str] = []
        fail = sat.StabilityPlan("backend-blackbox:y", [sys.executable, "-c", "raise SystemExit(1)"], work,
                                 [sat.WHOLE_UNIT], "t", env={"BLACKBOX_TEST_DATABASE_URL":
                                                             "postgresql://postgres:postgres@localhost:5432/victoria_stab-1"},
                                 databases=["victoria_stab-1"], server="postgresql://postgres:postgres@localhost:5432")
        with patch.object(sat, "_psql", side_effect=lambda server, sql, log=None: calls.append(sql) or True):
            row = sat._run_plan(1, fail, 5, 60, work, sat.CpuLoad(0, 60))
        check(row["status"] == "FAIL" and calls == ['CREATE DATABASE "victoria_stab-1"',
                                                    'DROP DATABASE IF EXISTS "victoria_stab-1" WITH (FORCE)']
              and row["databases"] == {"created": ["victoria_stab-1"], "dropped": ["victoria_stab-1"]},
              f"stability: the unit's own database is created once and dropped by exact name even after a failure ({calls})")

        mac = sat.Unit("mac-app-vitest", "mac-app/tests/blackbox/x.blackbox.ts", [str(work / "x.blackbox.ts")])
        (work / "x.blackbox.ts").write_text("x")
        ok = work / "ok.py"
        ok.write_text("pass\n")
        passing = sat.Unit("cloudbench-controller", f"{sys.executable} {ok}", [str(ok)])
        with patch.object(sat.sys, "platform", "linux"):
            report = sat.run_stability([mac, passing], load_workers=1, timeout=60, log_root=work / "logs-mac")
            alone = sat.run_stability([mac], load_workers=1, timeout=60, log_root=work / "logs-mac-alone")
        mac_row = report["units"][f"mac-app-vitest:{mac.name}"]
        check(report["status"] == "PASS" and mac_row["status"] == "PLATFORM_OMITTED" and not mac_row["executed"]
              and report["counts"] == {"PASS": 1, "PLATFORM_OMITTED": 1}
              and alone["status"] == "PLATFORM_OMITTED" and alone["counts"] == {"PLATFORM_OMITTED": 1},
              f"stability: mac-app on Linux is PLATFORM_OMITTED, outside the PASS count, never UNVERIFIED ({report['counts']})")
        printed = io.StringIO()
        with patch.object(sat, "new_test_units", return_value=[mac]), patch.object(sat.sys, "platform", "linux"), \
                patch.object(sat, "run_stability",
                             (lambda real: lambda *a, **k: real(*a, **{**k, "log_root": work / "logs-mac-cli"}))(sat.run_stability)), \
                contextlib.redirect_stdout(printed):
            code = sat.main(["--stability", "--changed-file", "x.blackbox.ts", "--load-workers", "1"])
        check(code == 0 and "PLATFORM_OMITTED" in printed.getvalue() and "not a test pass" in printed.getvalue(),
              "stability: an only-omitted check exits 0 and prints the omission, not a pass")


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

    check_extraction_precision(selector)
    check_lanes_for()
    check_new_test_stability()
    check_stability_concurrency()
    check_stability_case_selection()
    check_stability_blackbox_cases()
    check_stability_backend_lanes()

    print(f"select-affected-tests: {len(FAILURES)} failure(s)")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
