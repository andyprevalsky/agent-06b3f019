#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rca-archive-new.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

python3 - "$ROOT_DIR/scripts/rca_archive.py" "$TEST_ROOT" <<'PY'
import importlib.util
import sys
from pathlib import Path

tool_path = Path(sys.argv[1])
test_root = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("rca_archive_under_test", tool_path)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load {tool_path}")

archive = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = archive
spec.loader.exec_module(archive)
archive.REPO_ROOT = test_root
archive.CASES_DIR = test_root / "cases"
archive.INDEX_PATH = test_root / "INDEX.md"
archive.today = lambda: "2026-08-03"

sys.argv = [str(tool_path), "new", "dispatch-regression"]
exit_code = archive.main()
if exit_code != 0:
    raise AssertionError(f"new command exited {exit_code}, expected 0")

case_path = archive.CASES_DIR / "2026-08-03-dispatch-regression.md"
if not case_path.is_file():
    raise AssertionError(f"new command did not create {case_path}")
if "id: 2026-08-03-dispatch-regression" not in case_path.read_text(encoding="utf-8"):
    raise AssertionError("new command created a case with the wrong ID")
PY

echo "RCA archive new-command dispatch passed."
