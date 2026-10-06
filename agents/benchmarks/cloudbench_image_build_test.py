"""Compact controls for the dependency graph consumed by the real image builder.

These inspect Docker's build inputs and graph, not model or benchmark outcomes.
Actual uncached builds own timing and dependency-artifact validation.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
IMAGES = ("Dockerfile.cloudbench-warm", "Dockerfile.cloudbench")


@dataclass
class Stage:
    name: str
    parent: str
    instructions: list[tuple[str, str]] = field(default_factory=list)


def recipe(path: Path) -> dict[str, Stage]:
    stages: dict[str, Stage] = {}
    pending = ""
    current: Stage | None = None
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        pending += line.rstrip("\\").strip() + " "
        if line.endswith("\\"):
            continue
        instruction, value = pending.strip().split(None, 1)
        pending = ""
        instruction = instruction.upper()
        if instruction == "FROM":
            tokens = shlex.split(value)
            name = tokens[2] if len(tokens) == 3 else f"stage-{len(stages)}"
            current = Stage(name, tokens[0])
            stages[name] = current
        else:
            assert current is not None
            current.instructions.append((instruction, value))
    return stages


def copies(stage: Stage) -> list[tuple[str | None, list[str], str]]:
    result = []
    for instruction, value in stage.instructions:
        if instruction != "COPY":
            continue
        tokens = shlex.split(value)
        source_stage = None
        while tokens[0].startswith("--"):
            option = tokens.pop(0)
            if option.startswith("--from="):
                source_stage = option.partition("=")[2]
        result.append((source_stage, tokens[:-1], tokens[-1]))
    return result


def ancestors(stages: dict[str, Stage], name: str) -> set[str]:
    stage = stages[name]
    parents = {stage.parent} if stage.parent in stages else set()
    parents.update(source for source, _, _ in copies(stage) if source in stages)
    return parents | {older for parent in parents for older in ancestors(stages, parent)}


def install_stage(stages: dict[str, Stage], command: str) -> str:
    matches = [
        name
        for name, stage in stages.items()
        if any(instruction == "RUN" and command in value for instruction, value in stage.instructions)
    ]
    assert len(matches) == 1
    return matches[0]


def input_fingerprint(stages: dict[str, Stage], name: str, fixture: Path) -> str:
    """Hash the context files the named builder stage actually depends on."""
    digest = hashlib.sha256()
    for stage_name in sorted({name} | ancestors(stages, name)):
        for source_stage, sources, _ in copies(stages[stage_name]):
            if source_stage is not None:
                continue
            for source in sources:
                paths = [fixture] if source == "." else sorted(fixture.glob(source))
                for path in paths:
                    files = sorted(path.rglob("*")) if path.is_dir() else [path]
                    for item in files:
                        if item.is_file():
                            digest.update(str(item.relative_to(fixture)).encode())
                            digest.update(item.read_bytes())
    return digest.hexdigest()


def context_fixture(path: Path) -> None:
    files = {
        "package.json": '{"workspaces":["back-end","front-end","agents"]}',
        "package-lock.json": "root-lock",
        "back-end/package.json": "backend-manifest",
        "back-end/package-lock.json": "backend-lock",
        "front-end/package.json": "frontend-manifest",
        "front-end/package-lock.json": "frontend-lock",
        "back-end/prisma/schema.prisma": "schema-v1",
        "agents/requirements.txt": "requirements-v1",
        "back-end/src/example.ts": "source-v1",
        "scripts/cloudbench-install-pgvector.sh": "vector-installer",
        "scripts/cloudbench-install-ngrok.sh": "tunnel-installer",
        "scripts/cloudbench-entrypoint.sh": "entrypoint",
        "scripts/cloudbench-install-image-deps.sh": "joined-installer",
    }
    for name, content in files.items():
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)


@pytest.mark.parametrize("image", IMAGES)
def test_cloudbench_image_build_installs_in_final_layer_without_artifact_copies(image: str) -> None:
    stages = recipe(ROOT / image)
    final = stages[list(stages)[-1]]
    assert all(source is None for source, _, _ in copies(final)), "dependency copies repeat large tree materialization"
    assert any(
        instruction == "RUN" and "cloudbench-install-image-deps.sh" in value
        for instruction, value in final.instructions
    )


@pytest.mark.parametrize("image", IMAGES)
def test_cloudbench_image_build_accepts_a_fresh_tracked_checkout(image: str) -> None:
    # Include pending publishable source additions; ignored generated locks must
    # still never become mandatory inputs to a fresh clone.
    tracked = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT, text=True
    ).split("\0")
    for stage in recipe(ROOT / image).values():
        for source_stage, sources, _ in copies(stage):
            if source_stage is not None:
                continue
            for source in sources:
                if source == ".":
                    continue
                assert any(
                    name.startswith(source.rstrip("/") + "/")
                    or (name.count("/") == source.count("/") and fnmatch.fnmatchcase(name, source))
                    for name in tracked
                ), f"fresh clones have no build input matching {source}"


def dependency_input_fingerprint(stages: dict[str, Stage], fixture: Path) -> str:
    # Docker only keys the install step on instructions preceding that step.
    selected = {}
    for name, stage in stages.items():
        instructions = []
        for instruction, value in stage.instructions:
            if instruction == "RUN" and "cloudbench-install-image-deps.sh" in value:
                break
            instructions.append((instruction, value))
        selected[name] = Stage(name, stage.parent, instructions)
    return input_fingerprint(selected, list(selected)[-1], fixture)


@pytest.mark.parametrize("image", IMAGES)
def test_cloudbench_image_build_source_last_keeps_manifest_and_schema_cache_boundary(
    tmp_path: Path, image: str
) -> None:
    stages = recipe(ROOT / image)
    context_fixture(tmp_path)
    before = dependency_input_fingerprint(stages, tmp_path)
    (tmp_path / "back-end/src/example.ts").write_text("source-v2")
    assert dependency_input_fingerprint(stages, tmp_path) == before
    for changed in (
        "package-lock.json",
        "back-end/package.json",
        "back-end/package-lock.json",
        "front-end/package.json",
        "front-end/package-lock.json",
        "back-end/prisma/schema.prisma",
        "agents/requirements.txt",
        "scripts/cloudbench-install-image-deps.sh",
    ):
        target = tmp_path / changed
        target.write_text(target.read_text() + "-edited")
        after = dependency_input_fingerprint(stages, tmp_path)
        assert after != before, changed
        before = after


@pytest.mark.parametrize("image", IMAGES)
def test_cloudbench_image_build_preserves_donor_paths_and_runtime_contract(image: str) -> None:
    stages = recipe(ROOT / image)
    final = stages[list(stages)[-1]]
    assert (None, ["."], "/app") in copies(final)
    install = next(
        i
        for i, (kind, value) in enumerate(final.instructions)
        if kind == "RUN" and "cloudbench-install-image-deps.sh" in value
    )
    source = next(
        i
        for i, (kind, value) in enumerate(final.instructions)
        if kind == "COPY" and shlex.split(value)[-2:] == [".", "/app"]
    )
    assert install < source
    assert any(kind == "USER" and value == "rose" for kind, value in final.instructions[:install])
    assert list(stages.values())[0].parent == "node:20-bookworm"
    assert ("WORKDIR", "/app") in list(stages.values())[0].instructions
    assert ("USER", "root") in final.instructions
    assert ("ENV", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1") in final.instructions
    ignore = (ROOT / ".dockerignore").read_text().splitlines()
    assert "**/node_modules" in ignore and "**/venv" in ignore
    if image.endswith("-warm"):
        assert ("CMD", '["bash", "-c", "exec sleep infinity"]') in final.instructions
    else:
        assert ("ENTRYPOINT", '["/usr/local/bin/cloudbench-entrypoint.sh"]') in final.instructions


def _image_build_process_state(pid: int, birth: str) -> str:
    """Observe exact native execution state; lookup failures remain unknown."""
    try:
        observed = subprocess.run(
            ["ps", "-p", str(pid), "-o", "lstart=", "-o", "stat="],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        return "unknown"
    fields = observed.stdout.split()
    if observed.returncode == 0 and len(fields) >= 6:
        if " ".join(fields[:-1]) != birth:
            return "replaced"
        return "terminal" if fields[-1].startswith("Z") else "live"
    if observed.returncode == 1:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return "absent"
        except PermissionError:
            pass
    return "unknown"


@pytest.mark.parametrize("builder", [None, "native"])
def test_cloudbench_image_build_cli_cancellation_joins_only_owned_publishers(
    tmp_path: Path, builder: str | None
) -> None:
    # CLI → real cloud controller → real publisher → controlled local provider.
    # Its unrelated same-group sibling must survive exact controller TERM.
    context = tmp_path / "checkout"
    libraries = context / "scripts/lib"
    libraries.mkdir(parents=True)
    (context / "Dockerfile.cloudbench-warm").write_text("FROM fixture-only\n")
    (context / "fly.cloudbench-warm.toml").write_text('app = "fixture-only"\n')
    (libraries / "cloudbench-env.sh").write_text(f"source {shlex.quote(str(ROOT / 'scripts/lib/cloudbench-env.sh'))}\n")
    for name in ("cloudbench-github-token.sh", "cloudbench-app-env-lock.sh"):
        (libraries / name).write_text("")
    provider = tmp_path / "publisher"
    ownership = tmp_path / "publisher-owner.json"
    provider.write_text(
        f"#!{sys.executable}\n"
        "import json,os,subprocess,sys,time\n"
        "from pathlib import Path\n"
        "if sys.argv[1] != 'deploy' or '--push' not in sys.argv or '--build-only' not in sys.argv: sys.exit(91)\n"
        "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'])\n"
        "def birth(pid): return ' '.join(subprocess.check_output(['ps','-p',str(pid),'-o','lstart='],text=True).split())\n"
        "record={'processes':[[os.getpid(),birth(os.getpid())],[child.pid,birth(child.pid)]],"
        "'builder':'depot' if '--depot=true' in sys.argv else 'native'}\n"
        "target=Path(os.environ['IMAGE_TEST_OWNERSHIP']); temporary=target.with_suffix('.tmp')\n"
        "temporary.write_text(json.dumps(record)); temporary.replace(target)\n"
        "child.wait()\n"
    )
    provider.chmod(0o700)
    (libraries / "cloudbench-image-publisher.sh").write_text(
        f"source {shlex.quote(str(ROOT / 'scripts/lib/cloudbench-image-publisher.sh'))}\n"
        f"cloudbench_image_publisher_client() {{ printf '%s\\n' {shlex.quote(str(provider))}; }}\n"
    )
    binaries = tmp_path / "bin"
    binaries.mkdir()
    flyctl = binaries / "flyctl"
    flyctl.write_text("#!/usr/bin/env bash\nexit 92\n")
    flyctl.chmod(0o700)
    output = tmp_path / "private-output"
    env = {
        **os.environ,
        "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
        "CLOUDBENCH_FLEET_ROOT": str(context),
        "CLOUDBENCH_SCRIPT_SNAPSHOT": str(libraries),
        "FLY_BENCH_API_TOKEN": "fixture-only-token-long-enough",
        "WARM_IMAGE_REF": "",
        "IMAGE_TEST_OWNERSHIP": str(ownership),
        "RUN_BENCH_CLOUD_BIN_UNDER_TEST": str(ROOT / "scripts/run-bench-cloud"),
    }
    arguments = [
        shutil.which("bash"),
        str(ROOT / "scripts/run-bench"),
        "image-build",
        "--no-cache",
        "--build-context",
        str(context),
        "--out-dir",
        str(output),
    ]
    if builder is not None:
        arguments += ["--builder", builder]
    processes = []
    sibling = None
    with (tmp_path / "private-cli.log").open("wb") as log:
        controller = subprocess.Popen(arguments, env=env, stdout=log, stderr=log, process_group=0)
        try:
            deadline = time.monotonic() + 60
            while not ownership.exists() and controller.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            assert ownership.is_file(), "controlled publisher did not start"
            record = json.loads(ownership.read_text())
            processes = record["processes"]
            assert record["builder"] == (builder or "depot")
            assert all(_image_build_process_state(pid, birth) == "live" for pid, birth in processes)
            sibling = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(120)"], process_group=controller.pid
            )
            sibling_birth = " ".join(
                subprocess.check_output(
                    ["ps", "-p", str(sibling.pid), "-o", "lstart="],
                    text=True,
                ).split()
            )
            controller.send_signal(signal.SIGTERM)
            controller.wait(timeout=60)
            states = [_image_build_process_state(pid, birth) for pid, birth in processes]
            while "unknown" in states and time.monotonic() < deadline:
                time.sleep(0.1)
                states = [_image_build_process_state(pid, birth) for pid, birth in processes]
            assert all(state in {"absent", "terminal", "replaced"} for state in states), (
                f"owned publisher states after CLI exit: {states}"
            )
            assert controller.returncode == 143
            assert _image_build_process_state(sibling.pid, sibling_birth) == "live"
            assert not (output / "cloudbench-image-build.json").exists()
            assert not (output / "cloudbench-image-publication.json").exists()
        finally:
            if controller.poll() is None:
                controller.terminate()
                try:
                    controller.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    controller.kill()
                    controller.wait(timeout=10)
            # Fixture cleanup is restricted to the native births captured here.
            for pid, birth in processes:
                if _image_build_process_state(pid, birth) == "live":
                    os.kill(pid, signal.SIGKILL)
            if sibling is not None:
                sibling.terminate()
                sibling.wait(timeout=10)
