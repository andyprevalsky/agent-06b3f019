"""Structural test: every blackbox test function is actually registered and run.

`agents/tests/blackbox/*.blackbox.py` are NOT auto-discovered. `run_blackbox_tests.py`
only calls each module's `run_all_tests()`, so a `test_*` function that nobody
registers via `r.record(...)` / `await r.record_async(...)` silently never runs —
and the suite still reports green. That directly defeats CLAUDE.md rule 1
("functionality is only guaranteed if a test measures it and that test is cemented
in a consistently-run path"): the test exists, looks like coverage in review, and
measures nothing.

A function is considered registered if its name appears anywhere in its own file
beyond its own `def` line — that covers direct `r.record(name, fn)` registration
and the `test_x()` -> `_x_case()` wrapper convention.

KNOWN_UNREGISTERED is a ratcheting debt ledger, not an exemption list. It records
tests that were already dead when this guard landed. It may only SHRINK: registering
one of these (and deleting its ledger entry) is always correct, and the guard fails
if a ledger entry becomes registered but is left behind, so the ledger cannot go
stale. Adding a NEW entry is never the right fix — register the test instead.
"""

import ast
import asyncio
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from _result import Result as BlackboxResult

AGENTS_ROOT = Path(__file__).resolve().parent.parent.parent
BLACKBOX_DIR = AGENTS_ROOT / "tests" / "blackbox"
STRUCTURAL_DIR = AGENTS_ROOT / "tests" / "structural"

# Pre-existing dead tests, captured when this guard landed. Only ever remove entries.
KNOWN_UNREGISTERED: dict[str, frozenset[str]] = {
    "benchmark.blackbox.py": frozenset(
        [
        ]
    ),
    "llm.blackbox.py": frozenset(
        [
            "test_call_llm_structured_streaming_replayed_native_tool_call_without_json",
        ]
    ),
    "request_payment_card.blackbox.py": frozenset(
        [
        ]
    ),
    "rose_browser_use.blackbox.py": frozenset(
        [
        ]
    ),
    "spawn_browser_agent_v3.blackbox.py": frozenset(
        [
        ]
    ),
    "tool_schemas.blackbox.py": frozenset(
        [
        ]
    ),
}


def _is_test_function(name: str) -> bool:
    """Both blackbox naming conventions: `test_*`, and the `_*_case` async-body form.

    Several suites split an async test into `_<name>_case()` (the body) plus a thin
    registered wrapper. A `_*_case` helper is just as dead as a `test_*` function
    when nothing references it, so hold both to the same rule.
    """
    return name.startswith("test_") or (name.startswith("_") and name.endswith("_case"))


def _unregistered_tests(path: Path) -> set[str]:
    """Module-level test functions whose name is never referenced in their own file."""
    source = path.read_text()
    tree = ast.parse(source)
    unregistered = set()
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not _is_test_function(node.name):
            continue
        # The definition itself is one occurrence; any further occurrence means
        # something references it (registration, or a wrapper that calls it).
        if source.count(node.name) <= 1:
            unregistered.add(node.name)
    return unregistered


def test_every_blackbox_test_is_registered():
    """A new blackbox test must be registered in its module's run_all_tests()."""
    new_dead = []
    for path in sorted(BLACKBOX_DIR.glob("*.blackbox.py")):
        allowed = KNOWN_UNREGISTERED.get(path.name, frozenset())
        for name in sorted(_unregistered_tests(path) - allowed):
            new_dead.append(f"{path.name}::{name}")

    assert not new_dead, (
        f"{len(new_dead)} blackbox test(s) are defined but never run — nothing "
        f"registers them, so the suite reports green while measuring nothing:\n"
        + "\n".join(f"  - {v}" for v in new_dead)
        + "\n\nFix: register each in that file's run_all_tests(), e.g.\n"
        '  await r.record_async("<name>", <fn>)   # async test\n'
        '  r.record("<name>", <fn>)               # sync test\n'
        "Do NOT add it to KNOWN_UNREGISTERED — that ledger only shrinks."
    )


def test_known_unregistered_ledger_is_not_stale():
    """Ledger entries that got registered (or deleted) must be removed from the ledger."""
    stale = []
    for filename, names in sorted(KNOWN_UNREGISTERED.items()):
        path = BLACKBOX_DIR / filename
        if not path.exists():
            stale.append(f"{filename} (file no longer exists)")
            continue
        still_dead = _unregistered_tests(path)
        for name in sorted(names - still_dead):
            stale.append(f"{filename}::{name} (now registered or deleted)")

    assert not stale, (
        f"{len(stale)} stale KNOWN_UNREGISTERED entr(ies) — the debt was paid but "
        f"the ledger still lists it. Remove these so the ratchet cannot slip back:\n"
        + "\n".join(f"  - {v}" for v in stale)
    )


STRUCTURAL_GATE = "scripts/tests/agents-structural.test.sh"


def test_every_structural_suite_runs_in_test_sh_and_deploy():
    """Every structural suite runs wherever the agents structural gate runs.

    `/deploy` Step 4s and every scripts/test.sh "Agents Structural" suite run
    the one gate script, and the gate must run every suite file: a suite named
    by hand in only some of those places silently never runs there.
    """
    repo_root = AGENTS_ROOT.parent
    test_sh = (repo_root / "scripts" / "test.sh").read_text()
    structural_lines = [line for line in test_sh.splitlines() if '"Agents Structural"' in line]
    assert structural_lines, 'scripts/test.sh must register an "Agents Structural" suite'
    assert all(f"bash {STRUCTURAL_GATE}" in line for line in structural_lines), (
        f'every "Agents Structural" line of scripts/test.sh must run {STRUCTURAL_GATE}: {structural_lines}'
    )

    with tempfile.TemporaryDirectory() as tmp:
        record = Path(tmp) / "ran.txt"
        recorder = Path(tmp) / "python"
        recorder.write_text(f'#!/bin/sh\necho "$1" >> "{record}"\n')
        recorder.chmod(0o755)
        gate = subprocess.run(
            ["bash", str(repo_root / STRUCTURAL_GATE)],
            env={**os.environ, "PYTHON_BIN": str(recorder)},
            capture_output=True,
            text=True,
            timeout=60,
        )
        ran = record.read_text().split() if record.exists() else []
    assert gate.returncode == 0, gate.stderr
    expected = [f"tests/structural/{path.name}" for path in sorted(STRUCTURAL_DIR.glob("structural*.py"))]
    assert sorted(ran) == expected, f"{STRUCTURAL_GATE} ran {ran}, expected every suite {expected}"


def missing_test_sh_suite_paths(test_sh: str, repo_root: Path) -> list[str]:
    """scripts/tests paths named by run_suite/bg_suite lines that do not exist."""
    import re

    lines = [line for line in test_sh.splitlines() if re.match(r"\s*(run_suite|bg_suite) ", line)]
    paths = {m for line in lines for m in re.findall(r"scripts/tests/[A-Za-z0-9_./-]+\.(?:py|sh|ts|js|mjs)\b", line)}
    return sorted(path for path in paths if not (repo_root / path).is_file())


def test_every_test_sh_suite_path_exists():
    """A run_suite naming a missing file fails every run instead of testing anything."""
    repo_root = AGENTS_ROOT.parent
    test_sh = (repo_root / "scripts" / "test.sh").read_text()
    assert missing_test_sh_suite_paths('  run_suite "X" python3 scripts/tests/absent-fixture.test.py\n', repo_root) == [
        "scripts/tests/absent-fixture.test.py"
    ]
    missing = missing_test_sh_suite_paths(test_sh, repo_root)
    assert not missing, f"scripts/test.sh registers missing suite files: {missing}"


async def run_all_tests():
    print("structural-test-registration tests:")
    r = BlackboxResult()
    r.record("every_blackbox_test_is_registered", test_every_blackbox_test_is_registered)
    r.record("known_unregistered_ledger_is_not_stale", test_known_unregistered_ledger_is_not_stale)
    r.record(
        "every_structural_suite_runs_in_test_sh_and_deploy", test_every_structural_suite_runs_in_test_sh_and_deploy
    )
    r.record("every_test_sh_suite_path_exists", test_every_test_sh_suite_path_exists)
    return r.all_passed


if __name__ == "__main__":
    passed = asyncio.run(run_all_tests())
    sys.exit(0 if passed else 1)
