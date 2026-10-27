"""Compact controls for the dependency graph consumed by the real image builder.

These inspect Docker's build inputs and graph, not model or benchmark outcomes.
Actual uncached builds own timing and dependency-artifact validation.
"""

from __future__ import annotations

import fnmatch
import hashlib
import io
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from benchmarks.cloudbench_image_cli_test import _image_dependency_inputs

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


def test_cloudbench_image_build_actual_context_excludes_nested_generated_state(tmp_path: Path) -> None:
    """Observe Docker's packed upload, with no daemon or private workspace inputs."""
    docker = shutil.which("docker")
    assert docker is not None, "Docker CLI is a normal cloudbench prerequisite"
    context = tmp_path / "context"
    context.mkdir()
    required = {
        "agents/worker.py": b"runtime-worker\n",
        "back-end/src/server.ts": b"runtime-backend\n",
        "scripts/cloudbench-entrypoint.sh": b"runtime-entrypoint\n",
        "agents/benchmarks/tasks.json": b'{"tasks":["fixture"]}\n',
        "agents/benchmarks/history/task_attempts.jsonl": b'{"task":"fixture","attempt":1}\n',
        "agents/benchmarks/history/span_durations.jsonl": b'{"span":"fixture","seconds":1}\n',
        "agents/benchmarks/history/task_durations.jsonl": b'{"task":"fixture","seconds":1}\n',
        # The staged image git seed must reach /app for fresh-volume fetches (descend I11).
        ".cloudbench-git-seed/cloudbench-seed.json": b'{"schema": "cloudbench-git-seed-v1"}\n',
    }
    generated = {
        f"{prefix}{directory}/generated-marker": b"generated-state-must-stay-local\n"
        for prefix in ("", "agents/", "back-end/", "agents/nested/deep/")
        for directory in (".context", ".llm-dumps")
    }
    for name, content in {**required, **generated}.items():
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (context / "Dockerfile").write_text("FROM scratch\nCOPY . /fixture\n")
    (context / ".dockerignore").write_bytes((ROOT / ".dockerignore").read_bytes())
    config = tmp_path / "docker-config"
    config.mkdir()
    uploads: list[bytes] = []

    class Receiver(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args: object) -> None:
            pass

        def reply(self, body: bytes) -> None:
            self.send_response(200)
            self.send_header("API-Version", "1.47")
            self.send_header("OSType", "linux")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def do_HEAD(self) -> None:
            self.reply(b"")

        def do_GET(self) -> None:
            self.reply(b"OK" if self.path.endswith("/_ping") else b'{"ApiVersion":"1.47","OSType":"linux"}')

        def do_POST(self) -> None:
            assert self.path.split("?", 1)[0].endswith("/build")
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                chunks = []
                while size := int(self.rfile.readline().split(b";", 1)[0], 16):
                    chunks.append(self.rfile.read(size))
                    assert self.rfile.read(2) == b"\r\n"
                assert self.rfile.readline() == b"\r\n"
                body = b"".join(chunks)
            else:
                body = self.rfile.read(int(self.headers["Content-Length"]))
            uploads.append(body)
            self.reply(b'{"stream":"synthetic context received\\n"}\n')

    # Explicit local transport and empty auth config isolate this synthetic
    # receiver; every inherited proxy key remains unchanged in the child.
    with HTTPServer(("127.0.0.1", 0), Receiver) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        try:
            result = subprocess.run(
                [
                    docker,
                    "--config",
                    str(config),
                    "--host",
                    f"tcp://127.0.0.1:{server.server_port}",
                    "--tls=false",
                    "build",
                    str(context),
                ],
                env={**os.environ, "DOCKER_BUILDKIT": "0", "DOCKER_TLS_VERIFY": "", "DOCKER_CONTEXT": ""},
                capture_output=True,
                timeout=30,
            )
        finally:
            server.shutdown()
            thread.join(timeout=5)
        assert not thread.is_alive()
    assert result.returncode == 0, "Docker CLI failed to upload the synthetic context"
    assert len(uploads) == 1
    with tarfile.open(fileobj=io.BytesIO(uploads[0]), mode="r:*") as archive:
        files = {
            member.name.removeprefix("./"): archive.extractfile(member).read()
            for member in archive.getmembers()
            if member.isfile()
        }
    assert all(files.get(name) == content for name, content in required.items()), "runtime inputs were omitted"
    assert not generated.keys() & files.keys(), "generated state entered Docker's build archive"


@pytest.mark.parametrize("contender", ["none", "concurrent", "early-failure"])
def test_cloudbench_image_build_stages_an_exact_git_seed_and_removes_it(tmp_path: Path, contender: str) -> None:
    """Real CLI image-build: the publisher sees a verified depth-1 seed of HEAD; none remains after."""
    context = tmp_path / "checkout"
    libraries = context / "scripts/lib"
    libraries.mkdir(parents=True)
    _image_dependency_inputs(context)
    registry = context / "agents/providers/rose/pools.py"
    registry.parent.mkdir(parents=True)
    shutil.copyfile(ROOT / "agents/providers/rose/pools.py", registry)
    (context / "Dockerfile.cloudbench-warm").write_text("FROM fixture-only\n")
    (context / "fly.cloudbench-warm.toml").write_text('app = "fixture-only"\n')
    (context / ".gitignore").write_bytes((ROOT / ".gitignore").read_bytes())
    (libraries / "cloudbench-env.sh").write_text(f"source {shlex.quote(str(ROOT / 'scripts/lib/cloudbench-env.sh'))}\n")
    for name in ("cloudbench-github-token.sh", "cloudbench-app-env-lock.sh"):
        (libraries / name).write_text("")
    git = ["git", "-C", str(context), "-c", "user.name=fixture", "-c", "user.email=fixture@example.com"]
    subprocess.run(["git", "init", "-q", str(context)], check=True)
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-qm", "first"], check=True)
    (context / "agents/history.jsonl").write_text("ledger\n" * 1000)
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-qm", "build commit"], check=True)
    head = subprocess.check_output([*git, "rev-parse", "HEAD"], text=True).strip()
    provider = tmp_path / "publisher"
    observed = tmp_path / "publisher-observed.json"
    provider.write_text(
        f"#!{sys.executable}\n"
        "import json,os,subprocess,sys,time\n"
        "from pathlib import Path\n"
        "if sys.argv[1] != 'deploy': sys.exit(91)\n"
        "seed=Path(sys.argv[2])/'.cloudbench-git-seed'\n"
        "def git(*a): return subprocess.run(['git','--git-dir',str(seed),*a],capture_output=True,text=True)\n"
        "manifest=json.loads((seed/'cloudbench-seed.json').read_text())\n"
        "status=subprocess.check_output(['git','-C',sys.argv[2],'status','--porcelain'],text=True)\n"
        "record={'manifest':manifest,'shallow':(seed/'shallow').read_text().strip(),"
        "'tree':git('cat-file','-e',manifest['commit']+'^{tree}').returncode,"
        "'parent':git('cat-file','-e',manifest['commit']+'^').returncode,'status':status}\n"
        "target=Path(os.environ['IMAGE_TEST_OBSERVED']); temporary=target.with_suffix('.tmp')\n"
        "temporary.write_text(json.dumps(record)); temporary.replace(target)\n"
        "time.sleep(120)\n"
    )
    provider.chmod(0o700)
    (libraries / "cloudbench-image-publisher.sh").write_text(
        f"source {shlex.quote(str(ROOT / 'scripts/lib/cloudbench-image-publisher.sh'))}\n"
        f"cloudbench_image_publisher_client() {{ if [ \"${{IMAGE_TEST_CLIENT_FAILURE:-0}}\" = 1 ]; then : > \"$IMAGE_TEST_EARLY_READY\"; sleep 120; return 79; fi; printf '%s\\n' {shlex.quote(str(provider))}; }}\n"
    )
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-qm", "publisher fixture"], check=True)
    head = subprocess.check_output([*git, "rev-parse", "HEAD"], text=True).strip()
    binaries = tmp_path / "bin"
    binaries.mkdir()
    (binaries / "flyctl").write_text("#!/usr/bin/env bash\nexit 92\n")
    (binaries / "flyctl").chmod(0o700)
    env = {
        **os.environ,
        "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
        "CLOUDBENCH_FLEET_ROOT": str(context),
        "CLOUDBENCH_SCRIPT_SNAPSHOT": str(libraries),
        "FLY_BENCH_API_TOKEN": "fixture-only-token-long-enough",
        "WARM_IMAGE_REF": "",
        "IMAGE_TEST_OBSERVED": str(observed),
        "RUN_BENCH_CLOUD_BIN_UNDER_TEST": str(ROOT / "scripts/run-bench-cloud"),
    }
    arguments = [shutil.which("bash"), str(ROOT / "scripts/run-bench"), "image-build", "--no-cache",
                 "--build-context", str(context), "--out-dir", str(tmp_path / "private-output")]
    with (tmp_path / "private-cli.log").open("wb") as log:
        controller = subprocess.Popen(arguments, env=env, stdout=log, stderr=log, process_group=0)
        try:
            deadline = time.monotonic() + 60
            while not observed.exists() and controller.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            assert observed.is_file(), (tmp_path / "private-cli.log").read_text()
            record = json.loads(observed.read_text())
            seed = context / ".cloudbench-git-seed"
            seed_inode = seed.stat().st_ino
            packs = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in (seed / "objects/pack").iterdir()}
            if contender != "none":
                competing_observed = tmp_path / "competing-observed.json"
                early_ready = tmp_path / "early-client-ready"
                competing_env = dict(env, IMAGE_TEST_OBSERVED=str(competing_observed),
                                     IMAGE_TEST_EARLY_READY=str(early_ready),
                                     IMAGE_TEST_CLIENT_FAILURE="1" if contender == "early-failure" else "0")
                competing_arguments = arguments[:-1] + [str(tmp_path / "competing-output")]
                with (tmp_path / "competing.log").open("wb") as competing_log:
                    competing = subprocess.Popen(competing_arguments, env=competing_env,
                                                 stdout=competing_log, stderr=competing_log,
                                                 process_group=0)
                    try:
                        deadline = time.monotonic() + 15
                        while competing.poll() is None and not competing_observed.exists() and not early_ready.exists() and time.monotonic() < deadline:
                            time.sleep(.02)
                        if competing.poll() is None:
                            competing.send_signal(signal.SIGTERM)
                        competing.wait(timeout=30)
                        assert competing.returncode != 0, "a second build entered the occupied seed context"
                        assert controller.poll() is None, "contender disturbed the original publisher owner"
                        assert seed.is_dir(), "another invocation deleted the active builder's seed"
                        assert seed.stat().st_ino == seed_inode, "another invocation replaced the active builder's seed"
                        assert {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in (seed / "objects/pack").iterdir()} == packs
                        assert not competing_observed.exists(), "a second publisher entered the occupied context"
                    finally:
                        if competing.poll() is None:
                            competing.send_signal(signal.SIGTERM)
                            competing.wait(timeout=30)
            controller.send_signal(signal.SIGTERM)
            controller.wait(timeout=60)
        finally:
            if controller.poll() is None:
                controller.send_signal(signal.SIGTERM)
                controller.wait(timeout=60)
    # The image carries exactly the pushed build commit, depth 1 (no history),
    # and staging it does not make the build context's provenance dirty.
    assert record["manifest"] == {"schema": "cloudbench-git-seed-v1", "commit": head}
    assert record["shallow"] == head
    assert record["tree"] == 0 and record["parent"] != 0
    assert record["status"] == ""
    assert not (context / ".cloudbench-git-seed").exists(), "image git seed outlived the build"


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
    _image_dependency_inputs(context)
    registry = context / "agents/providers/rose/pools.py"
    registry.parent.mkdir(parents=True)
    shutil.copyfile(ROOT / "agents/providers/rose/pools.py", registry)
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
