"""Local benchmark children preserve configured and absent inherited proxies."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

AGENTS_DIR = Path(__file__).resolve().parents[2]
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

from benchmarks.local import benchmark_runner_env, run_streamed_command

PROXIED_ENV = {
    "PATH": "/usr/bin:/bin",
    "HTTPS_PROXY": "http://upper-https.example.invalid:7769",
    "https_proxy": "http://lower-https.example.invalid:7769",
    "HTTP_PROXY": "http://upper-http.example.invalid:7769",
    "http_proxy": "http://lower-http.example.invalid:7769",
    "ALL_PROXY": "http://upper-all.example.invalid:7769",
    "all_proxy": "http://lower-all.example.invalid:7769",
    "NO_PROXY": "upper.example.invalid",
    "no_proxy": "lower.example.invalid",
}
PROXY_KEYS = tuple(key for key in PROXIED_ENV if key != "PATH")


def test_runner_env_preserves_inherited_proxy_configuration() -> None:
    for original in (PROXIED_ENV, {"PATH": PROXIED_ENV["PATH"]}):
        before = dict(original)
        env = benchmark_runner_env(original)
        assert original == before
        for name in PROXY_KEYS:
            assert (name in env) == (name in original)
            assert env.get(name) == original.get(name)
        assert env["PYTHONUNBUFFERED"] == "1"
        assert env["BENCHMARK_FAST_MODE_CACHE"] == "false"

    # Resolve the configured environment through Python's real proxy discovery.
    # This reads configuration; it makes no network request.
    resolved = subprocess.run(
        [sys.executable, "-c", "import json,urllib.request; print(json.dumps(urllib.request.getproxies()))"],
        env=benchmark_runner_env(PROXIED_ENV),
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert json.loads(resolved) == {
        "https": PROXIED_ENV["https_proxy"],
        "http": PROXIED_ENV["http_proxy"],
        "all": PROXIED_ENV["all_proxy"],
        "no": PROXIED_ENV["no_proxy"],
    }


def test_runner_env_keeps_an_explicit_demo_cache_choice() -> None:
    env = benchmark_runner_env({**PROXIED_ENV, "BENCHMARK_FAST_MODE_CACHE": "true"})
    assert env["BENCHMARK_FAST_MODE_CACHE"] == "true"


def test_streamed_benchmark_commands_preserve_inherited_proxies() -> None:
    for original in (PROXIED_ENV, {"PATH": PROXIED_ENV["PATH"]}):
        code, output = run_streamed_command(
            [
                sys.executable,
                "-c",
                "import json,os; print(json.dumps({name: os.environ.get(name) for name in "
                + repr(PROXY_KEYS) + "}))",
            ],
            cwd=AGENTS_DIR,
            env=dict(original),
            check=True,
        )
        assert code == 0
        assert json.loads(output.strip().splitlines()[-1]) == {
            name: original.get(name) for name in PROXY_KEYS
        }
