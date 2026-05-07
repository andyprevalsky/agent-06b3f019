"""Blackbox tests for benchmark helpers."""

from _test_utils import BlackboxResult


def test_extract_worker_pids_from_ps_matches_macos_python_executable():
    """Worker detection matches macOS venv processes named Python."""
    from benchmarks.run_benchmark import _extract_worker_pids_from_ps

    ps_output = """
      111 /Users/me/project/agents/venv/bin/Python worker.py
      222 /usr/bin/python3 other.py
      333 node server.js
    """

    assert _extract_worker_pids_from_ps(ps_output) == ["111"]


def test_extract_worker_pids_from_ps_matches_lowercase_python():
    """Worker detection still matches the common python worker.py command."""
    from benchmarks.run_benchmark import _extract_worker_pids_from_ps

    ps_output = """
      444 python worker.py
      555 /usr/bin/python3 -m pytest
    """

    assert _extract_worker_pids_from_ps(ps_output) == ["444"]


def test_ci_should_fail_on_skipped_required_task():
    """CI treats skipped benchmark tasks as blocking failures."""
    from benchmarks.run_benchmark import _ci_should_fail

    assert _ci_should_fail({"failed": 0, "skipped": 1}) is True
    assert _ci_should_fail({"failed": 0}) is False


async def run_all_tests():
    print("benchmark blackbox tests:")
    r = BlackboxResult()
    r.record("extract_worker_pids_macos_python", test_extract_worker_pids_from_ps_matches_macos_python_executable)
    r.record("extract_worker_pids_lowercase_python", test_extract_worker_pids_from_ps_matches_lowercase_python)
    r.record("ci_fails_on_skipped", test_ci_should_fail_on_skipped_required_task)
    return r.all_passed
