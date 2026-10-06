"""Cold image builds use the supported CLI and retain their exact inputs."""

import hashlib
import io
import json
import os
import shlex
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash")
PUBLISHER_LIB = ROOT / "scripts/lib/cloudbench-image-publisher.sh"


@pytest.mark.parametrize(
    "image",
    [
        "registry.fly.io/navi-whisper-lux-bench:cloudbench-warm-fixture",
        "registry.fly.io/navi-whisper-lux-bench@sha256:" + "a" * 64,
        "registry.fly.io/navi-whisper-lux-bench:cloudbench-warm-fixture@sha256:" + "a" * 64,
    ],
)
def test_cold_image_activation_uses_owned_setup_without_rebuilding(tmp_path, image):
    child = tmp_path / "cloud.sh"
    observed = tmp_path / "activation.json"
    child.write_text(
        "#!/usr/bin/env bash\n"
        "python3 -c 'import json,os,sys; "
        'open(os.environ["IMAGE_TEST_ARGS"],"w").write(json.dumps({"args":sys.argv[1:],'
        '"image":os.environ.get("WARM_IMAGE_REF")}))\' "$@"\n'
    )
    result = subprocess.run(
        [
            BASH,
            str(ROOT / "scripts/run-bench"),
            "image-activate",
            image,
            "--ref",
            "fixture-sha",
            "--out-dir",
            "private-output",
        ],
        cwd=tmp_path,
        env={**os.environ, "RUN_BENCH_CLOUD_BIN_UNDER_TEST": str(child), "IMAGE_TEST_ARGS": str(observed)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(observed.read_text()) == {
        "args": ["--setup", "--ref", "fixture-sha", "--out-dir", str(tmp_path / "private-output")],
        "image": image,
    }


@pytest.mark.parametrize(
    "argument",
    [
        "registry.fly.io/navi-whisper-lux:production",
        "registry.fly.io/navi-whisper-lux-bench",
        "registry.fly.io/navi-whisper-lux-bench:valid --push",
    ],
)
def test_cold_image_activation_rejects_wrong_or_inexact_images(tmp_path, argument):
    child = tmp_path / "must-not-run.sh"
    observed = tmp_path / "called"
    child.write_text(f"touch {shlex.quote(str(observed))}\n")
    result = subprocess.run(
        [BASH, str(ROOT / "scripts/run-bench"), "image-activate", argument],
        env={**os.environ, "RUN_BENCH_CLOUD_BIN_UNDER_TEST": str(child)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 2
    assert not observed.exists()


@pytest.mark.parametrize(
    "options",
    [
        ["--ref", "--out-dir"],
        ["--ref", ""],
        ["--out-dir", ""],
        ["--ref"],
        ["--unknown", "value"],
    ],
)
def test_cold_image_activation_rejects_missing_option_values_before_setup(tmp_path, options):
    child = tmp_path / "must-not-run.sh"
    observed = tmp_path / "called"
    child.write_text(f"touch {shlex.quote(str(observed))}\n")
    result = subprocess.run(
        [
            BASH,
            str(ROOT / "scripts/run-bench"),
            "image-activate",
            "registry.fly.io/navi-whisper-lux-bench:fixture",
            *options,
        ],
        env={**os.environ, "RUN_BENCH_CLOUD_BIN_UNDER_TEST": str(child)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 2
    assert not observed.exists()


def test_cold_image_activation_propagates_owned_setup_failure(tmp_path):
    child = tmp_path / "failed-setup.sh"
    child.write_text("exit 29\n")
    result = subprocess.run(
        [BASH, str(ROOT / "scripts/run-bench"), "image-activate", "registry.fly.io/navi-whisper-lux-bench:fixture"],
        env={**os.environ, "RUN_BENCH_CLOUD_BIN_UNDER_TEST": str(child)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 29


def _publisher_fixture(tmp_path, version="0.4.112"):
    client = (
        "#!/usr/bin/env bash\n"
        f"if [ \"${{1:-}}\" = version ]; then echo 'flyctl v{version} fixture'; exit 0; fi\n"
        "python3 -c 'import json,os,sys; "
        'open(os.environ["IMAGE_TEST_ARGS"],"w").write(json.dumps({"args":sys.argv[1:],'
        '"docker_buildkit":os.environ.get("DOCKER_BUILDKIT")}))\' "$@"\n'
    ).encode()
    archive = tmp_path / "publisher.tar.gz"
    with tarfile.open(archive, "w:gz") as output:
        member = tarfile.TarInfo("flyctl")
        member.size = len(client)
        member.mode = 0o700
        output.addfile(member, io.BytesIO(client))
    return archive, hashlib.sha256(archive.read_bytes()).hexdigest(), client


def _install_publisher(tmp_path, archive, checksum):
    harness = tmp_path / "install.sh"
    harness.write_text(
        f"source {shlex.quote(str(PUBLISHER_LIB))}\n"
        f"cloudbench_image_install_client {shlex.quote(str(tmp_path / 'cache'))} "
        f"{shlex.quote(archive.as_uri())} {checksum} 0.4.112\n"
    )
    return subprocess.run([BASH, str(harness)], capture_output=True, text=True, timeout=30)


def test_cold_image_publisher_cache_is_verified_and_reused(tmp_path):
    archive, checksum, client = _publisher_fixture(tmp_path)
    first = _install_publisher(tmp_path, archive, checksum)
    assert first.returncode == 0, first.stderr
    executable = Path(first.stdout.strip())
    assert executable.read_bytes() == client
    assert executable.stat().st_mode & 0o777 == 0o700
    archive.unlink()
    second = _install_publisher(tmp_path, archive, checksum)
    assert second.returncode == 0, second.stderr
    assert second.stdout.strip() == str(executable)
    assert executable.read_bytes() == client


def test_cold_image_publisher_corrupt_cache_is_replaced(tmp_path):
    archive, checksum, client = _publisher_fixture(tmp_path)
    first = _install_publisher(tmp_path, archive, checksum)
    assert first.returncode == 0, first.stderr
    executable = Path(first.stdout.strip())
    executable.write_bytes(b"corrupted cached publisher\n")
    repaired = _install_publisher(tmp_path, archive, checksum)
    assert repaired.returncode == 0, repaired.stderr
    assert executable.read_bytes() == client


def test_cold_image_publisher_rejects_unverified_asset(tmp_path):
    archive, _, _ = _publisher_fixture(tmp_path)
    result = _install_publisher(tmp_path, archive, "0" * 64)
    assert result.returncode != 0
    assert not (tmp_path / "cache/flyctl").exists()


def test_cold_image_publisher_rejects_wrong_client_version(tmp_path):
    archive, checksum, _ = _publisher_fixture(tmp_path, version="0.4.76")
    result = _install_publisher(tmp_path, archive, checksum)
    assert result.returncode != 0
    assert not (tmp_path / "cache/flyctl").exists()


@pytest.mark.parametrize("builder", ["native", "depot"])
def test_cold_image_publisher_scopes_transport_to_build_child(tmp_path, builder):
    archive, checksum, _ = _publisher_fixture(tmp_path)
    installed = _install_publisher(tmp_path, archive, checksum)
    assert installed.returncode == 0, installed.stderr
    observed = tmp_path / "arguments.json"
    harness = tmp_path / "publish.sh"
    harness.write_text(
        f"source {shlex.quote(str(PUBLISHER_LIB))}\n"
        f"cloudbench_image_publisher_client() {{ printf '%s\\n' {shlex.quote(installed.stdout.strip())}; }}\n"
        f"IMAGE_BUILD_BUILDER={builder}\n"
        "export DOCKER_BUILDKIT=1\n"
        "cloudbench_image_publish deploy unchanged-context --build-only --push\n"
        'test "$DOCKER_BUILDKIT" = 1\n'
    )
    result = subprocess.run(
        [BASH, str(harness)],
        env={**os.environ, "IMAGE_TEST_ARGS": str(observed)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    invocation = json.loads(observed.read_text())
    assert invocation["args"] == ["deploy", "unchanged-context", "--build-only", "--push", "--wg=false"]
    assert invocation["docker_buildkit"] == ("0" if builder == "native" else "1")


@pytest.mark.parametrize("builder", [None, "native", "depot"])
def test_cold_image_cli_routes_without_task_selection(tmp_path, builder):
    child = tmp_path / "cloud.sh"
    observed = tmp_path / "arguments.json"
    child.write_text(
        "#!/usr/bin/env bash\n"
        "python3 -c 'import json,os,sys; "
        'open(os.environ["IMAGE_TEST_ARGS"],"w").write(json.dumps(sys.argv[1:]))\' "$@"\n'
    )
    options = ["--no-cache", "--build-context", str(tmp_path)]
    if builder is not None:
        options.extend(["--builder", builder])
    result = subprocess.run(
        [BASH, str(ROOT / "scripts/run-bench"), "image-build", *options],
        env={**os.environ, "RUN_BENCH_CLOUD_BIN_UNDER_TEST": str(child), "IMAGE_TEST_ARGS": str(observed)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(observed.read_text()) == ["--build-image", *options]


@pytest.mark.parametrize("flag", ["--setup", "--destroy", "--refresh-secrets", "chat-mode"])
def test_cold_image_cli_rejects_lifecycle_and_task_arguments(tmp_path, flag):
    child = tmp_path / "cloud.sh"
    observed = tmp_path / "called"
    child.write_text(f"touch '{observed}'\n")
    result = subprocess.run(
        [BASH, str(ROOT / "scripts/run-bench"), "image-build", flag],
        env={**os.environ, "RUN_BENCH_CLOUD_BIN_UNDER_TEST": str(child)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 2
    assert not observed.exists()


@pytest.mark.parametrize("arguments", [["--builder", "unknown"], ["--builder"]])
def test_cold_image_cli_rejects_unknown_or_missing_builder(tmp_path, arguments):
    child = tmp_path / "cloud.sh"
    observed = tmp_path / "called"
    child.write_text(f"touch {shlex.quote(str(observed))}\n")
    result = subprocess.run(
        [BASH, str(ROOT / "scripts/run-bench"), "image-build", *arguments],
        env={**os.environ, "RUN_BENCH_CLOUD_BIN_UNDER_TEST": str(child)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 2
    assert not observed.exists()


@pytest.mark.parametrize(
    "arguments",
    [["--build-image", "--builder", "unknown"], ["--build-image", "--builder"], ["--setup", "--builder", "depot"]],
)
def test_cold_image_builder_rejected_before_auth(tmp_path, arguments):
    root = tmp_path / "checkout"
    libraries = root / "scripts/lib"
    libraries.mkdir(parents=True)
    (libraries / "cloudbench-env.sh").write_text("")
    (libraries / "cloudbench-app-env-lock.sh").write_text("")
    observed = tmp_path / "auth-called"
    (libraries / "cloudbench-github-token.sh").write_text(
        f"cloudbench_export_controller_github_token() {{ touch {shlex.quote(str(observed))}; }}\n"
    )
    result = subprocess.run(
        [BASH, str(ROOT / "scripts/run-bench-cloud"), *arguments],
        env={**os.environ, "CLOUDBENCH_FLEET_ROOT": str(root), "CLOUDBENCH_SCRIPT_SNAPSHOT": str(libraries)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 2
    assert not observed.exists()


@pytest.mark.parametrize("mode", ["--build-image", "--setup"])
def test_cold_image_build_skips_repository_auth_export(tmp_path, mode):
    root = tmp_path / "checkout"
    libraries = root / "scripts/lib"
    libraries.mkdir(parents=True)
    (libraries / "cloudbench-env.sh").write_text(f"source {shlex.quote(str(ROOT / 'scripts/lib/cloudbench-env.sh'))}\n")
    (libraries / "cloudbench-app-env-lock.sh").write_text("")
    (libraries / "cloudbench-image-publisher.sh").write_text(
        'cloudbench_image_publish() { FLY "$@"; }\n'
        "cloudbench_image_publisher_client() { printf '%s\\n' fixture-publisher; }\n"
    )
    # Exercise the real env writer with fixture credentials, then stop setup
    # before it reaches any provider. Image-only builds must skip it entirely.
    (libraries / "cloudbench-github-token.sh").write_text(
        "cloudbench_controller_github_token() { printf '%s\\n' fixture-controller-token; }\n"
        'fixture_export="$(declare -f cloudbench_export_controller_github_token)"\n'
        'eval "${fixture_export/cloudbench_export_controller_github_token/fixture_export_token}"\n'
        'cloudbench_export_controller_github_token() { fixture_export_token "$@"; exit 73; }\n'
    )
    env_files = [root / "agents/.env", root / "back-end/.env"]
    for path in env_files:
        path.parent.mkdir()
        path.write_text("PRESERVED=fixture-value\n")
    (root / "Dockerfile.cloudbench-warm").write_text("FROM fixture-source\n")
    (root / "fly.cloudbench-warm.toml").write_text('app = "fixture-source"\n')
    binaries = tmp_path / "bin"
    binaries.mkdir()
    provider = binaries / "flyctl"
    provider.write_text("#!/usr/bin/env bash\nexit 0\n")
    provider.chmod(0o700)
    result = subprocess.run(
        [BASH, str(ROOT / "scripts/run-bench-cloud"), mode],
        env={
            **os.environ,
            "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
            "CLOUDBENCH_FLEET_ROOT": str(root),
            "CLOUDBENCH_SCRIPT_SNAPSHOT": str(libraries),
            "FLY_BENCH_API_TOKEN": "fixture-only-fly-token-long-enough",
            "WARM_IMAGE_REF": "",
        },
        capture_output=True,
        text=True,
        timeout=30,
    )
    if mode == "--build-image":
        assert result.returncode == 0, result.stderr
        assert (root / ".context/cloudbench-image-build.json").is_file()
        for path in env_files:
            assert path.read_text() == "PRESERVED=fixture-value\n"
    else:
        assert result.returncode == 73
        for path in env_files:
            assert path.read_text() == "PRESERVED=fixture-value\nGITHUB_TOKEN=fixture-controller-token\n"


@pytest.mark.parametrize("builder", [None, "depot"])
def test_cold_image_build_keeps_provider_cache_bypass_and_context(tmp_path, builder):
    source = (ROOT / "scripts/run-bench-cloud").read_text()
    start = source.index("build_warm_image() {")
    end = source.index("\n}\n", start) + 3
    helper = source[start:end]
    context = tmp_path / "selected checkout"
    context.mkdir()
    (context / "fly.cloudbench-warm.toml").write_text('app = "fixture-selected-checkout"\n')
    (context / "Dockerfile.cloudbench-warm").write_text("FROM fixture-selected-checkout\n")
    observed = tmp_path / "arguments.json"
    harness = tmp_path / "build.sh"
    harness.write_text(
        "set -e\nAPP=owned-benchmark-app\n"
        f"ROOT_DIR={shlex.quote(str(ROOT))}\n"
        f"IMAGE_BUILD_CONTEXT={shlex.quote(str(context))}\n"
        "IMAGE_BUILD_NO_CACHE=1\nWARM_IMAGE_REF=''\n"
        + (f"IMAGE_BUILD_BUILDER={builder}\n" if builder is not None else "")
        + 'cloudbench_image_publish() { FLY "$@"; }\n'
        + "FLY() { python3 -c 'import json,os,sys; "
        'open(os.environ["IMAGE_TEST_ARGS"],"w").write(json.dumps({"args":sys.argv[1:],"cwd":os.getcwd()}))\' "$@"; }\n'
        + helper
        + "\nbuild_warm_image\n"
    )
    result = subprocess.run(
        [BASH, str(harness)],
        cwd=ROOT,
        env={**os.environ, "IMAGE_TEST_ARGS": str(observed)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    invocation = json.loads(observed.read_text())
    args = invocation["args"]
    assert args[0:2] == ["deploy", str(context)]
    assert "--no-cache" in args
    assert "--build-only" in args and "--push" in args
    assert args[args.index("--dockerfile") + 1] == str(context / "Dockerfile.cloudbench-warm")
    assert args[args.index("-c") + 1] == str(context / "fly.cloudbench-warm.toml")
    assert invocation["cwd"] == str(context)
    assert args[args.index("-a") + 1] == "owned-benchmark-app"
    assert "--remote-only" in args
    assert "--buildkit" not in args and "--platform" not in args
    if builder == "depot":
        assert "--depot=true" in args and "--depot=false" not in args
        assert "--depot-scope=app" in args
        assert "--compression=zstd" in args and "--compression-level=3" in args
    else:
        assert "--depot=false" in args and "--depot=true" not in args
        assert not any(argument.startswith(("--depot-scope", "--compression")) for argument in args)


@pytest.mark.parametrize("builder", [None, "depot"])
def test_cold_image_receipt_records_selected_inputs_before_provider_build(tmp_path, builder):
    source = (ROOT / "scripts/run-bench-cloud").read_text()
    start = source.index("build_warm_image() {")
    end = source.index("# MODE: --setup", start)
    context = tmp_path / "selected checkout"
    context.mkdir()
    files = {
        "Dockerfile.cloudbench-warm": "FROM fixture-selected-checkout\n",
        "fly.cloudbench-warm.toml": 'app = "fixture-selected-checkout"\n',
    }
    for name, content in files.items():
        (context / name).write_text(content)
    git = ["git", "-C", str(context), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"]
    subprocess.run([*git, "init", "-q"], check=True, capture_output=True)
    subprocess.run([*git, "add", "."], check=True, capture_output=True)
    subprocess.run([*git, "commit", "-qm", "selected inputs"], check=True, capture_output=True)
    before = subprocess.check_output([*git, "rev-parse", "HEAD"], text=True).strip()
    # An unrelated tracked edit must be captured without printing any contents.
    (context / "source.py").write_text("pending branch edit\n")
    subprocess.run([*git, "add", "source.py"], check=True, capture_output=True)
    observer = tmp_path / "provider.py"
    observer.write_text(
        "import subprocess,sys\n"
        "from pathlib import Path\n"
        "context=Path(sys.argv[1])\n"
        "(context/'Dockerfile.cloudbench-warm').write_text('changed after provider launch\\n')\n"
        "subprocess.run(['git','-C',str(context),'-c','user.name=Fixture','-c',"
        "'user.email=fixture@example.invalid','commit','-qm','provider started'],check=True,capture_output=True)\n"
    )
    output = tmp_path / "receipt"
    output.mkdir()
    harness = tmp_path / "build.sh"
    harness.write_text(
        "set -e\nAPP=owned-benchmark-app\nMODE=build-image\n"
        f"ROOT_DIR={shlex.quote(str(ROOT))}\n"
        f"IMAGE_BUILD_CONTEXT={shlex.quote(str(context))}\n"
        f"OUT_DIR={shlex.quote(str(output))}\nIMAGE_BUILD_NO_CACHE=1\nWARM_IMAGE_REF=''\n"
        + (f"IMAGE_BUILD_BUILDER={builder}\n" if builder is not None else "")
        + 'cloudbench_image_publish() { FLY "$@"; }\n'
        + "cloudbench_image_publisher_client() { printf '%s\\n' fixture-publisher; }\n"
        + f"FLY() {{ python3 {shlex.quote(str(observer))} {shlex.quote(str(context))}; }}\n"
        + source[start:end]
    )
    result = subprocess.run(
        [BASH, str(harness)],
        cwd=ROOT,
        env={**os.environ, "FLY_DEV_PLATFORM": "linux/arm64"},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    receipt = json.loads((output / "cloudbench-image-build.json").read_text())
    assert receipt["source_sha"] == before
    assert receipt["source_dirty"] is True
    assert receipt["build_context"] == str(context)
    for name, field in [
        ("Dockerfile.cloudbench-warm", "dockerfile_sha256"),
        ("fly.cloudbench-warm.toml", "config_sha256"),
    ]:
        assert receipt[field] == hashlib.sha256(files[name].encode()).hexdigest()
    assert receipt["layer_cache_bypassed"] is True
    assert receipt["image_ref"].startswith("registry.fly.io/owned-benchmark-app:cloudbench-warm-")
    assert receipt["finished_epoch"] >= receipt["started_epoch"]
    assert (output / "cloudbench-image-build.json").stat().st_mode & 0o777 == 0o600
    assert receipt["requested_builder"] == (builder or "native")
    assert receipt["requested_builder_scope"] == ("app" if builder == "depot" else None)
    assert receipt["requested_compression"] == ("zstd" if builder == "depot" else None)
    assert receipt["requested_compression_level"] == (3 if builder == "depot" else None)
    assert receipt["requested_platform"] == ("linux/amd64" if builder == "depot" else "linux/arm64")
    assert receipt["image_publisher_version"] == "0.4.112"
    assert receipt["image_publisher_transport"] == "https"
    assert receipt["image_publisher_engine"] == ("depot-buildkit" if builder == "depot" else "docker-classic")


@pytest.mark.parametrize(
    "scenario,builder,successful,resolve_calls",
    [
        ("postpush", "native", True, 1),
        ("prepush", "native", False, 0),
        ("unrelated", "native", False, 0),
        ("unresolved", "native", False, 3),
        ("postpush", "depot", False, 0),
        ("normal", "native", True, 0),
        ("normal", "depot", True, 0),
        ("receipt-write", "native", False, 0),
    ],
)
def test_cold_image_published_tag_completion_prevents_only_proven_rebuild(
    tmp_path, scenario, builder, successful, resolve_calls
):
    source = (ROOT / "scripts/run-bench-cloud").read_text()
    start = source.index("build_warm_image() {")
    end = source.index("# MODE: --setup", start)
    context = tmp_path / "selected checkout"
    context.mkdir()
    (context / "Dockerfile.cloudbench-warm").write_text("FROM fixture\n")
    (context / "fly.cloudbench-warm.toml").write_text('app = "fixture"\n')
    output = tmp_path / "receipt"
    output.mkdir()
    if scenario == "receipt-write":
        (output / "cloudbench-image-publication.json").mkdir()
    calls = tmp_path / "calls.jsonl"
    publisher = tmp_path / "publisher.py"
    publisher.write_text(
        "#!/usr/bin/env python3\n"
        "import json,os,sys\n"
        "args=sys.argv[1:]\n"
        f"with open({str(calls)!r},'a') as handle:handle.write(json.dumps({{'args':args,'cwd':os.getcwd()}})+'\\n')\n"
        f"scenario={scenario!r}\n"
        "if '--image' in args:sys.exit(1 if scenario=='unresolved' else 0)\n"
        "print('fixture-private-line-not-human')\n"
        "if scenario in ('normal','receipt-write'):sys.exit(0)\n"
        "if scenario!='prepush':print('Pushing image done')\n"
        "if scenario=='unrelated':print('Error: unrelated publisher failure')\n"
        "else:print('Error: failed to fetch an image or build from source: count not find built image: Error response from daemon: You are not authorized to use this builder')\n"
        "sys.exit(1)\n"
    )
    publisher.chmod(0o700)
    harness = tmp_path / "build.sh"
    harness.write_text(
        "set -e\nAPP=owned-benchmark-app\nMODE=build-image\n"
        f"ROOT_DIR={shlex.quote(str(ROOT))}\n"
        f"IMAGE_BUILD_CONTEXT={shlex.quote(str(context))}\n"
        f"OUT_DIR={shlex.quote(str(output))}\nIMAGE_BUILD_NO_CACHE=1\nWARM_IMAGE_REF=''\n"
        f"IMAGE_BUILD_BUILDER={builder}\n"
        f"source {shlex.quote(str(PUBLISHER_LIB))}\n"
        f"cloudbench_image_publisher_client() {{ printf '%s\\n' {shlex.quote(str(publisher))}; }}\n"
        "sleep() { :; }\n" + source[start:end]
    )
    result = subprocess.run([BASH, str(harness)], capture_output=True, text=True, timeout=30)
    assert (result.returncode == 0) is successful, result.stderr
    observed = [json.loads(line) for line in calls.read_text().splitlines()]
    resolves = [call for call in observed if "--image" in call["args"]]
    builds = [call for call in observed if "--push" in call["args"]]
    assert len(resolves) == resolve_calls
    assert len(builds) == (1 if successful else 3)
    for resolve in resolves:
        args = resolve["args"]
        assert args[args.index("--image") + 1].startswith("registry.fly.io/owned-benchmark-app:cloudbench-warm-")
        assert args[args.index("-a") + 1] == "owned-benchmark-app"
        assert args[args.index("-c") + 1] == str(context / "fly.cloudbench-warm.toml")
        assert resolve["cwd"] == str(context)
        assert "--build-only" in args and "--push" not in args
        assert "--no-cache" not in args and "--wg=false" in args
        assert "--depot=false" in args and "--remote-only" in args
    if successful:
        receipt = json.loads((output / "cloudbench-image-build.json").read_text())
        assert receipt["publication_verified"] is True
        assert receipt["publisher_exit_code"] == (1 if scenario == "postpush" else 0)
        assert receipt["published_tag_resolution_verified"] is (scenario == "postpush")
        assert bool(receipt["publication_metadata_warning"]) is (scenario == "postpush")
        assert receipt["build_attempts"] == 1
    assert "fixture-private-line-not-human" not in result.stdout + result.stderr
    for private in output.glob("*.private.log"):
        assert private.stat().st_mode & 0o777 == 0o600
