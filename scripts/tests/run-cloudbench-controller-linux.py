#!/usr/bin/env python3
"""Run the unchanged controller fixture as root on Linux; other hosts use an offline container."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import uuid


TOOL_CHECK = """import re,shutil,subprocess,sys
assert sys.platform=='linux' and sys.version_info[:3]==(3,11,9), 'requires Linux Python3.11.9'
assert subprocess.check_output(['node','--version'],text=True).strip()=='v22.23.4', 'requires Node22.23.4'
assert int(subprocess.check_output(['bash','--version'],text=True).split('version ',1)[1].split('.',1)[0])>=5, 'requires Bash5+'
assert all(shutil.which(name) for name in ('git','curl','ps','rg')), 'requires git/curl/procps/ripgrep'
assert all(shutil.which(name) for name in ('npm','npx')), 'requires npm/npx'
package_runner_versions = [subprocess.check_output([name,'--version'],text=True).strip() for name in ('npm','npx')]
assert all(re.fullmatch(r'[0-9]+\\.[0-9]+\\.[0-9]+',version) for version in package_runner_versions), 'requires executable npm/npx version commands'
assert len(set(package_runner_versions))==1, 'requires npm/npx from the same package'
"""

# Every docker client call made before the fixture container exists is bounded.
# A wedged daemon or client otherwise holds the whole controller gate silently
# until its outer deadline (PR #1751: 70 minutes with an empty case log). The
# passing path takes seconds: inspect <1s, cold build ~25s, preflight run ~1s.
DOCKER_QUERY_TIMEOUT_SECONDS = 120
DOCKER_BUILD_TIMEOUT_SECONDS = 1200
DOCKER_PREFLIGHT_TIMEOUT_SECONDS = 300


def bounded_docker(step, timeout, call, *args, **kwargs):
    """Announce one docker client step, then fail it by name if it does not return."""
    print(f"docker step: {step}", file=sys.stderr, flush=True)
    try:
        return call(*args, timeout=timeout, **kwargs)
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"docker {step} did not finish within {timeout:g}s"
        ) from None


def retire_owned_container(
    snapshot: Path, name: str, owner: str, image_id: str
) -> bool:
    cidfile = snapshot / "container.cid"
    identity = cidfile.read_text().strip() if cidfile.is_file() else name
    if cidfile.is_file() and not re.fullmatch(r"[0-9a-f]{64}", identity):
        return False
    format_value = '{{.Id}}\n{{.Name}}\n{{index .Config.Labels "org.rose.controller-test-owner"}}\n{{.Image}}\n{{json .Mounts}}'
    result = subprocess.run(
        ["docker", "inspect", identity, "--format", format_value],
        capture_output=True,
        text=True,
    )
    if result.returncode:
        return result.returncode == 1 and any(
            value in result.stderr.lower()
            for value in ("no such object", "no such container")
        )
    fields = result.stdout.splitlines()
    if (
        len(fields) != 5
        or not re.fullmatch(r"[0-9a-f]{64}", fields[0])
        or fields[1] != "/" + name
        or fields[2] != owner
        or fields[3] != image_id
        or (cidfile.is_file() and fields[0] != identity)
    ):
        return False
    try:
        mounts = json.loads(fields[4])
    except ValueError:
        return False
    if not isinstance(mounts, list) or not all(isinstance(row, dict) for row in mounts):
        return False
    expected = [
        ("scripts", "/repo/scripts", False),
        ("agents/benchmarks", "/repo/agents/benchmarks", False),
        (
            "agents/providers/rose/pools.py",
            "/repo/agents/providers/rose/pools.py",
            False,
        ),
    ]
    if len(mounts) != len(expected) or not all(
        any(
            row.get("Type") == "bind"
            and Path(row.get("Source", "")).resolve() == (snapshot / relative).resolve()
            and row.get("Destination") == destination
            and row.get("RW") is writable
            for row in mounts
        )
        for relative, destination, writable in expected
    ):
        return False
    stopped_ok = False
    removed = False
    try:
        stopped = subprocess.run(
            ["docker", "stop", "--time", "30", fields[0]],
            capture_output=True,
            text=True,
        )
        if stopped.returncode:
            raise subprocess.CalledProcessError(stopped.returncode, stopped.args)
        stopped_ok = True
        archive = snapshot / "fixture-tmp"
        archive.mkdir(mode=0o700, exist_ok=True)
        exported = subprocess.run(
            ["docker", "cp", fields[0] + ":/tmp/.", str(archive)],
            capture_output=True,
            text=True,
        )
        if exported.returncode:
            print(
                "WARNING: controller diagnostic export is incomplete; native owner retirement is checked separately.",
                file=sys.stderr,
            )
    except (OSError, subprocess.SubprocessError):
        print(
            "WARNING: controller stop or diagnostic export raised an observation error; native retirement remains required.",
            file=sys.stderr,
        )
    finally:
        # Even partial diagnostics stay private; never follow exported symlinks.
        archive = snapshot / "fixture-tmp"
        try:
            for directory, directories, files in os.walk(archive, followlinks=False):
                Path(directory).chmod(0o700)
                directories[:] = [
                    item
                    for item in directories
                    if not (Path(directory) / item).is_symlink()
                ]
                for item in files:
                    path = Path(directory) / item
                    if stat.S_ISREG(path.lstat().st_mode):
                        path.chmod(0o600)
        except OSError:
            print(
                "WARNING: some private diagnostic files could not be sealed.",
                file=sys.stderr,
            )
        # A failed diagnostic export must not leave this exact verified owner behind.
        try:
            removed = (
                subprocess.run(
                    ["docker", "rm", fields[0]], capture_output=True, text=True
                ).returncode
                == 0
            )
        except (OSError, subprocess.SubprocessError):
            removed = False
    gone = subprocess.run(
        ["docker", "inspect", fields[0]], capture_output=True, text=True
    )
    return (
        stopped_ok
        and removed
        and gone.returncode == 1
        and any(
            value in gone.stderr.lower()
            for value in ("no such object", "no such container")
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument(
        "--fixture",
        choices=("multi-workstream", "status-service-shutdown", "export-recovery"),
        default="multi-workstream",
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    fixture = f"scripts/tests/cloudbench-{args.fixture}.test.sh"
    # The fixtures exercise root-only Linux permission primitives with the
    # pinned toolchain; any other host runs them in the same offline root container.
    if sys.platform == "linux" and os.geteuid() == 0:
        native = subprocess.run([sys.executable, "-c", TOOL_CHECK])
        if native.returncode == 0:
            if args.check_only:
                return 0
            os.execvp("bash", ["bash", str(root / fixture)])
        print(
            "host toolchain is not pinned Python3.11.9/Node22.23.4; "
            "using offline controller image",
            flush=True,
        )
    recipe = root / "scripts/tests/cloudbench-controller-linux.Dockerfile"
    fingerprint = hashlib.sha256(recipe.read_bytes()).hexdigest()
    configured = os.environ.get("CLOUDBENCH_CONTROLLER_TEST_IMAGE", "")
    image = configured or f"rose-cloudbench-controller-tests:{fingerprint[:16]}"
    inspection = bounded_docker(
        "image inspect",
        DOCKER_QUERY_TIMEOUT_SECONDS,
        subprocess.run,
        ["docker", "image", "inspect", image, "--format", "{{.Id}}"],
        capture_output=True,
        text=True,
    )
    if inspection.returncode:
        if configured:
            raise RuntimeError(
                "configured controller test image is unavailable locally"
            )
        with tempfile.TemporaryDirectory(
            prefix="cloudbench-controller-image-"
        ) as context:
            bounded_docker(
                "build",
                DOCKER_BUILD_TIMEOUT_SECONDS,
                subprocess.run,
                [
                    "docker",
                    "build",
                    "--label",
                    f"org.rose.controller-recipe-sha256={fingerprint}",
                    "-f",
                    str(recipe),
                    "-t",
                    image,
                    context,
                ],
                check=True,
            )
        inspection = bounded_docker(
            "image inspect after build",
            DOCKER_QUERY_TIMEOUT_SECONDS,
            subprocess.run,
            ["docker", "image", "inspect", image, "--format", "{{.Id}}"],
            capture_output=True,
            text=True,
            check=True,
        )
    image_id = inspection.stdout.strip()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise RuntimeError("controller image identity is invalid")
    if not configured:
        label = bounded_docker(
            "image label inspect",
            DOCKER_QUERY_TIMEOUT_SECONDS,
            subprocess.check_output,
            [
                "docker",
                "image",
                "inspect",
                image_id,
                "--format",
                '{{index .Config.Labels "org.rose.controller-recipe-sha256"}}',
            ],
            text=True,
        ).strip()
        if label != fingerprint:
            raise RuntimeError("cached controller image does not match its recipe")
    bounded_docker(
        "toolchain preflight run",
        DOCKER_PREFLIGHT_TIMEOUT_SECONDS,
        subprocess.run,
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "python3",
            image_id,
            "-c",
            TOOL_CHECK,
        ],
        check=True,
    )
    if args.check_only:
        print(
            json.dumps(
                {
                    "passed": True,
                    "image_id": image_id,
                    "recipe_sha256": fingerprint,
                    "network": "none",
                }
            )
        )
        return 0
    artifacts = root / ".context/cloudbench-controller-tests"
    artifacts.mkdir(parents=True, exist_ok=True)
    snapshot = Path(tempfile.mkdtemp(prefix="native-", dir=artifacts))
    files = subprocess.check_output(
        ["git", "ls-files", "scripts"], cwd=root, text=True
    ).splitlines()
    files += [
        f"agents/benchmarks/{name}.py"
        for name in (
            "agent_link_server",
            "fleet_startup_phase",
            "hub_upload",
            "outcome_publication",
            "seed_cache_path",
            "cloudbench_campaign_inventory_test",
            "cloudbench_campaign_workspace_test",
            "cloudbench_worker_qualification_test",
            "cloudbench_worker_evidence_test",
            "cloudbench_dependency_sync_test",
        )
    ]
    # The real controller resolves WMH_ROSE_POOL through this authoritative registry.
    registry = "agents/providers/rose/pools.py"
    if not (root / registry).is_file():
        raise RuntimeError("authoritative Rose pool registry is missing")
    files.append(registry)
    hashes = {}
    for name in files:
        source = root / name
        if not source.is_file():
            continue
        target = snapshot / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        hashes[name] = hashlib.sha256(target.read_bytes()).hexdigest()
        if hashlib.sha256(source.read_bytes()).hexdigest() != hashes[name]:
            raise RuntimeError("controller source changed during snapshot")
    (snapshot / "source.json").write_text(
        json.dumps({"image_id": image_id, "source_file_sha256": hashes}, indent=2)
        + "\n"
    )
    (snapshot / "fixture-tmp").mkdir(mode=0o700)
    owner = uuid.uuid4().hex
    name = "rose-cloudbench-controller-tests-" + owner[:16]
    (snapshot / "container-owner.json").write_text(
        json.dumps({"name": name, "owner": owner, "image_id": image_id}) + "\n"
    )
    command = [
        "docker",
        "run",
        # Match host process semantics: the fixture must be an ordinary PID,
        # and detached descendants need a real subreaper after parent exit.
        "--init",
        "--network",
        "none",
        "--cpus",
        "2",
        "--name",
        name,
        "--label",
        "org.rose.controller-test-owner=" + owner,
        "--cidfile",
        str(snapshot / "container.cid"),
        "--entrypoint",
        "/bin/bash",
        "-v",
        f"{snapshot / 'scripts'}:/repo/scripts:ro",
        "-v",
        f"{snapshot / 'agents/benchmarks'}:/repo/agents/benchmarks:ro",
        "-v",
        f"{snapshot / registry}:/repo/{registry}:ro",
        "--env",
        "TMPDIR=/tmp",
        "--env",
        "CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE=1",
    ]
    for proxy_key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ):
        if proxy_key in os.environ:
            command += ["--env", proxy_key]
    for key in os.environ:
        if (
            key.startswith("CLOUDBENCH_TEST_")
            and key != "CLOUDBENCH_TEST_KEEP_TMP_ON_FAILURE"
        ):
            command += ["--env", key]
    command += [image_id, "-lc", f"bash /repo/{fixture}"]
    print(f"Native controller artifacts: {snapshot}", flush=True)
    process = None
    prior = {}

    def cancel(signum, _frame):
        raise SystemExit(128 + signum)

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            prior[signum] = signal.signal(signum, cancel)
        process = subprocess.Popen(command)
        code = process.wait()
    finally:
        for signum in prior:
            signal.signal(signum, signal.SIG_IGN)
        try:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if not retire_owned_container(snapshot, name, owner, image_id):
                raise RuntimeError(
                    "exact controller container retirement was not proven"
                )
        finally:
            for signum, handler in prior.items():
                signal.signal(signum, handler)
    return code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f"controller Linux runner failed: {detail}", file=sys.stderr)
        raise SystemExit(1)
