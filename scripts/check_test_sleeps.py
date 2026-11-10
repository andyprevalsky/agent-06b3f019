#!/usr/bin/env python3
"""Ratchet: test files may not add fixed literal sleeps used as synchronization.

Our most frequent flake class is a test that sleeps a fixed, usually
sub-second, interval and then asserts, or races a wall-clock deadline. It
passes on an idle host and fails under CPU load. New tests wait for the
condition with the canonical helpers instead:

* Python: ``scripts/lib/condition_wait.py`` (``wait_until``,
  ``async_wait_until``, ``FakeClock``)
* backend TypeScript: ``back-end/src/tests/helpers/waitFor.ts``
  (``waitFor``, ``FakeClock``)
* front-end: testing-library ``waitFor`` / vitest fake timers

Counted per test file:

* Python (parsed with ``ast``): ``time.sleep(N)``, ``asyncio.sleep(N)``,
  ``anyio.sleep(N)``, ``trio.sleep(N)`` and a bare ``sleep(N)`` where ``N`` is
  a non-zero numeric literal. ``sleep(0)`` only yields to the event loop.
* TypeScript/JavaScript: ``setTimeout(fn, N)`` and promise ``setTimeout(N)``,
  ``sleep(N)``, ``delay(N)`` and ``waitForTimeout(N)`` with a non-zero numeric
  literal ``N``.

``scripts/test-sleep-baseline.json`` records the existing count per file. A
file whose count exceeds its baseline (new files have baseline 0) fails.
Counts may only go down: ``--update`` lowers entries to the current tree and
never raises one, and ``--base REF`` (default ``origin/main`` when available)
fails if the committed baseline raised any entry above that ref's baseline.
There is no inline suppression. A deliberate delay that simulates slow work,
rather than synchronizing, uses a named constant that says why.
"""

from __future__ import annotations

import argparse
import ast
import fnmatch
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "scripts" / "test-sleep-baseline.json"

PYTHON_TEST_GLOBS = (
    "agents/tests/**/*.py",
    "agents/**/test_*.py",
    "agents/**/*_test.py",
    "scripts/tests/**/*.py",
)
SCRIPT_TEST_GLOBS = (
    "back-end/src/tests/**/*.ts",
    "back-end/src/tests/**/*.tsx",
    "back-end/scripts/**/*.test.ts",
    "front-end/src/**/*.test.ts",
    "front-end/src/**/*.test.tsx",
    "front-end/src/tests/**/*.ts",
    "front-end/src/tests/**/*.tsx",
    "front-end/tests/**/*.ts",
    "front-end/e2e/**/*.ts",
    "mac-app/**/*.test.ts",
    "mac-app/**/*.test.tsx",
    "mac-app/tests/**/*.ts",
    "scripts/tests/**/*.ts",
    "scripts/tests/**/*.mjs",
    "scripts/tests/**/*.js",
)
EXCLUDED_PARTS = {"node_modules", "venv", ".venv", "__pycache__", ".git", ".context", "dist", "build", "coverage"}

PY_SLEEP_MODULES = {"time", "asyncio", "anyio", "trio"}
TS_SLEEP_CALL = re.compile(r"(?<![\w$])(setTimeout|sleep|delay|waitForTimeout)\s*\(")
NUMERIC_LITERAL = re.compile(r"^(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?$")


def _glob_match(path: str, pattern: str) -> bool:
    # fnmatch's "*" already crosses "/", so "**/" also has to match zero dirs.
    return fnmatch.fnmatchcase(path, pattern) or fnmatch.fnmatchcase(path, pattern.replace("**/", ""))


def classify(path: str) -> str | None:
    if EXCLUDED_PARTS.intersection(path.split("/")):
        return None
    if path.endswith(".py") and any(_glob_match(path, g) for g in PYTHON_TEST_GLOBS):
        return "python"
    if any(_glob_match(path, g) for g in SCRIPT_TEST_GLOBS):
        return "script"
    return None


def candidate_paths(root: Path) -> list[str]:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            check=True,
            capture_output=True,
        ).stdout.decode()
        paths = [p for p in out.split("\0") if p and classify(p) and (root / p).is_file()]
    except (OSError, subprocess.CalledProcessError):
        paths = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_PARTS]
            for name in filenames:
                paths.append(Path(dirpath, name).relative_to(root).as_posix())
    return sorted(p for p in paths if classify(p))


def _is_sleep_literal(node: ast.Call) -> bool:
    func = node.func
    if isinstance(func, ast.Attribute):
        if func.attr != "sleep" or not (isinstance(func.value, ast.Name) and func.value.id in PY_SLEEP_MODULES):
            return False
    elif not (isinstance(func, ast.Name) and func.id == "sleep"):
        return False
    if len(node.args) != 1 or node.keywords:
        return False
    arg = node.args[0]
    return (
        isinstance(arg, ast.Constant)
        and isinstance(arg.value, (int, float))
        and not isinstance(arg.value, bool)
        and arg.value != 0
    )


_PY_REGEX = re.compile(r"(?<![\w.])(?:(?:time|asyncio|anyio|trio)\.)?sleep\(\s*([\d.][\d_.eE+-]*)\s*\)")


_PY_PREFILTER = re.compile(r"sleep\(\s*[\d.]")


def python_sleep_lines(source: str) -> list[int]:
    if not _PY_PREFILTER.search(source):
        return []  # parsing every test file costs seconds; most have no literal sleep
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        lines = []
        for number, line in enumerate(source.splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            for match in _PY_REGEX.finditer(line):
                if NUMERIC_LITERAL.match(match.group(1)) and float(match.group(1).replace("_", "")) != 0:
                    lines.append(number)
        return lines
    return sorted(n.lineno for n in ast.walk(tree) if isinstance(n, ast.Call) and _is_sleep_literal(n))


_TOKENS = re.compile(
    r"//[^\n]*|/\*.*?\*/|\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`",
    re.DOTALL,
)


def _strip_comments(source: str) -> str:
    """Blank out comments and string contents, keeping quotes and line numbers."""

    def blank(match: re.Match[str]) -> str:
        text = match.group(0)
        if text.startswith(("//", "/*")):
            return "".join(c if c == "\n" else " " for c in text)
        return text[0] + "".join(c if c == "\n" else " " for c in text[1:-1]) + text[-1]

    return _TOKENS.sub(blank, source)


def _call_arguments(source: str, start: int) -> list[str] | None:
    """Top-level comma-split arguments of the call whose "(" is at ``start``."""
    depth, quote, args, current = 0, None, [], []
    i = start + 1
    while i < len(source):
        ch = source[i]
        if quote:
            current.append(ch)
            if ch == "\\":
                current.append(source[i + 1 : i + 2])
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
            current.append(ch)
        elif ch in "([{":
            depth += 1
            current.append(ch)
        elif ch in ")]}":
            if depth == 0:
                args.append("".join(current).strip())
                return [a for a in args if a] if any(args) else []
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            args.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
        i += 1
    return None


def _nonzero_literal(text: str) -> bool:
    return bool(NUMERIC_LITERAL.match(text)) and float(text.replace("_", "")) != 0


def script_sleep_lines(source: str) -> list[int]:
    code = _strip_comments(source)
    lines = []
    for match in TS_SLEEP_CALL.finditer(code):
        name = match.group(1)
        prefix = code[max(0, match.start() - 9) : match.start()]
        if re.search(r"function\s*$", prefix):
            continue  # a definition: `function sleep(ms) {`
        args = _call_arguments(code, match.end() - 1)
        if not args:
            continue
        if name == "setTimeout":
            literal = args[0] if len(args) == 1 else args[1]
        else:
            literal = args[0] if len(args) == 1 else ""
        if _nonzero_literal(literal):
            lines.append(code.count("\n", 0, match.start()) + 1)
    return lines


def sleep_lines(root: Path, path: str) -> list[int]:
    try:
        source = (root / path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return python_sleep_lines(source) if classify(path) == "python" else script_sleep_lines(source)


def scan(root: Path) -> dict[str, list[int]]:
    found = {}
    for path in candidate_paths(root):
        lines = sleep_lines(root, path)
        if lines:
            found[path] = lines
    return found


def load_baseline(path: Path) -> dict[str, int]:
    data = json.loads(path.read_text())
    counts = data.get("counts", {})
    if not all(isinstance(v, int) and v > 0 for v in counts.values()):
        raise SystemExit(f"{path}: counts must be positive integers")
    return counts


def write_baseline(path: Path, counts: dict[str, int]) -> None:
    payload = {
        "description": (
            "Fixed literal sleeps per test file (scripts/check_test_sleeps.py). Counts may only go down; "
            "use scripts/lib/condition_wait.py or back-end/src/tests/helpers/waitFor.ts instead of new sleeps."
        ),
        "counts": dict(sorted(counts.items())),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n")


def base_baseline(root: Path, ref: str, baseline: Path) -> dict[str, int] | None:
    try:
        rel = baseline.resolve().relative_to(root.resolve()).as_posix()
        text = subprocess.run(
            ["git", "-C", str(root), "show", f"{ref}:{rel}"], check=True, capture_output=True, text=True
        ).stdout
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None
    return json.loads(text).get("counts", {})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--base", help="git ref whose baseline the committed one may not exceed (default origin/main)")
    parser.add_argument("--update", action="store_true", help="lower baseline entries to the current tree")
    parser.add_argument("--init", action="store_true", help="create the baseline when none exists")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    baseline_path = args.baseline or root / "scripts" / "test-sleep-baseline.json"
    found = scan(root)
    current = {path: len(lines) for path, lines in found.items()}

    if args.init:
        if baseline_path.exists():
            print(f"{baseline_path} already exists; use --update to lower it", file=sys.stderr)
            return 2
        write_baseline(baseline_path, current)
        print(f"wrote {baseline_path}: {sum(current.values())} sleeps in {len(current)} files")
        return 0

    if not baseline_path.exists():
        print(f"FAIL: missing baseline {baseline_path} (create it once with --init)", file=sys.stderr)
        return 1
    baseline = load_baseline(baseline_path)

    failures = []
    ref = args.base or "origin/main"
    previous = base_baseline(root, ref, baseline_path)
    if previous is not None:
        for path, count in sorted(baseline.items()):
            if count > previous.get(path, 0):
                failures.append(
                    f"{path}: baseline raised to {count} (was {previous.get(path, 0)} on {ref}); counts may only go down"
                )
    elif args.base:
        print(f"note: no baseline at {ref}; skipping the baseline-increase check")

    for path, lines in sorted(found.items()):
        allowed = baseline.get(path, 0)
        if len(lines) > allowed:
            failures.append(
                f"{path}: {len(lines)} fixed literal sleeps, baseline {allowed} (lines {', '.join(map(str, lines))})"
            )

    if args.update:
        if failures:
            print("refusing --update: it never raises a count", file=sys.stderr)
        else:
            lowered = {p: min(c, current[p]) for p, c in baseline.items() if current.get(p)}
            write_baseline(baseline_path, lowered)
            print(f"baseline lowered: {sum(baseline.values())} -> {sum(lowered.values())} sleeps")

    if failures:
        print("FAIL: test files added fixed literal sleeps used as synchronization:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        print(
            "Wait for the condition instead: Python scripts/lib/condition_wait.py (wait_until, FakeClock); "
            "backend back-end/src/tests/helpers/waitFor.ts; front-end testing-library waitFor or fake timers. "
            "See docs/testing.md 'Waiting in tests'.",
            file=sys.stderr,
        )
        return 1
    stale = sum(c - current.get(p, 0) for p, c in baseline.items() if c > current.get(p, 0))
    print(
        f"test sleep ratchet OK: {sum(current.values())} literal sleeps in {len(current)} files"
        + (f" ({stale} below baseline; run with --update to lower it)" if stale else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
