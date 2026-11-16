"""Private roots for tests that execute a complete fleet controller entrypoint."""

import base64
from contextlib import contextmanager
from pathlib import Path
import os
import subprocess

FIXTURE_TOKEN = "fixture-controller-token"
FIXTURE_ENV = "PRESERVED=fixture-value\nGITHUB_TOKEN=fixture-original\n"


def _file_state(path):
    return (path.is_symlink(), path.read_bytes()) if path.exists() else None


@contextmanager
def isolated_controller_checkout(source, destination):
    """Keep real controller/exporter code, with private state and dummy auth."""
    source, destination = Path(source), Path(destination)
    scripts = destination / "scripts"
    scripts.mkdir(parents=True)
    for item in (source / "scripts").iterdir():
        target = scripts / item.name
        if item.name in {"run-bench-fleet", "run-bench-cloud"}:
            target.write_bytes(item.read_bytes())
            target.chmod(item.stat().st_mode & 0o777)
        else:
            target.symlink_to(item, target_is_directory=item.is_dir())
    # Controller inputs are read-only aliases; state, Git and dotenvs are private.
    for name in ("agents/benchmarks", ".claude", "Dockerfile.cloudbench-warm", "fly.cloudbench-warm.toml"):
        origin = source / name
        if origin.exists():
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(origin, target_is_directory=origin.is_dir())
    for part in ("agents", "back-end"):
        target = destination / part / ".env"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(FIXTURE_ENV)
        target.chmod(0o600)
    env = dict(os.environ)
    env.update(
        # This source has highest precedence, ahead of Git helpers and process auth.
        CLOUDBENCH_GITHUB_TOKEN_B64=base64.b64encode(FIXTURE_TOKEN.encode()).decode(),
        CLOUDBENCH_FLEET_ROOT=str(destination),
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_SYSTEM=os.devnull,
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_COUNT="0",
    )
    subprocess.run(["git", "init", "-q", str(destination)], env=env, check=True)
    subprocess.run(["git", "-C", str(destination), "-c", "user.name=Fixture",
                    "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"],
                   env=env, check=True)
    originals = {source / part / ".env": _file_state(source / part / ".env")
                 for part in ("agents", "back-end")}
    try:
        yield scripts / "run-bench-fleet", env
    finally:
        assert all(_file_state(path) == state for path, state in originals.items()), "controller fixture changed caller credentials"
        expected = FIXTURE_ENV.replace("fixture-original", FIXTURE_TOKEN)
        for part in ("agents", "back-end"):
            assert (destination / part / ".env").read_text() in (FIXTURE_ENV, expected), "controller fixture persisted non-fixture auth"
