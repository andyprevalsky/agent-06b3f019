"""Compact controls for the dependency graph consumed by the real image builder.

These inspect Docker's build inputs and graph, not model or benchmark outcomes.
Actual uncached builds own timing and dependency-artifact validation.
"""

from __future__ import annotations

import fnmatch
import hashlib
import shlex
import subprocess
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
