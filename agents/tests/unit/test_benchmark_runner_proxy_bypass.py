"""Cement: local benchmark runner subprocesses never use the host system proxy.

The isolated stack services already bypassed the macOS system proxy, but the
run_benchmark.py runner did not. With Freedom's proxy (127.0.0.1:7769) active,
a pre-agent fixture call hung on an idle proxied TLS socket and the predeploy
smoke batch never finished its last task.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

AGENTS_DIR = Path(__file__).resolve().parents[2]
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

from benchmarks.local import benchmark_runner_env, run_streamed_command

PROXIED_ENV = {
    "PATH": "/usr/bin:/bin",
    "HTTPS_PROXY": "http://127.0.0.1:7769",
    "https_proxy": "http://127.0.0.1:7769",
    "HTTP_PROXY": "http://127.0.0.1:7769",
    "ALL_PROXY": "http://127.0.0.1:7769",
}


def test_runner_env_drops_proxies_and_bypasses_system_proxy() -> None:
    env = benchmark_runner_env(PROXIED_ENV)
    assert env["NO_PROXY"] == "*"
    assert env["no_proxy"] == "*"
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        assert name not in env
    assert env["PYTHONUNBUFFERED"] == "1"
    assert env["BENCHMARK_FAST_MODE_CACHE"] == "false"

    # urllib (and requests/httpx, which build on it) fall back to the macOS
    # system proxy only when no proxy variable is set; the runner env must
    # resolve to no proxy at all.
    resolved = subprocess.run(
        [sys.executable, "-c", "import urllib.request; print(sorted(urllib.request.getproxies().items()))"],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert resolved == "[('no', '*')]", resolved


def test_runner_env_keeps_an_explicit_fast_cache_choice() -> None:
    env = benchmark_runner_env({**PROXIED_ENV, "BENCHMARK_FAST_MODE_CACHE": "true"})
    assert env["BENCHMARK_FAST_MODE_CACHE"] == "true"


def test_streamed_benchmark_commands_bypass_the_host_proxy() -> None:
    code, output = run_streamed_command(
        [
            sys.executable,
            "-c",
            "import os; print(os.environ.get('NO_PROXY'), os.environ.get('HTTPS_PROXY'))",
        ],
        cwd=AGENTS_DIR,
        env=dict(PROXIED_ENV),
        check=True,
    )
    assert code == 0
    assert output.strip().splitlines()[-1] == "* None"
