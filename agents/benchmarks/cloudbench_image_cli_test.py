"""Cold image builds use the supported CLI and retain their exact inputs."""

import hashlib
import io
import json
import os
import runpy
import shlex
import shutil
import subprocess
import sys
import tarfile
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash")
PUBLISHER_LIB = ROOT / "scripts/lib/cloudbench-image-publisher.sh"


@contextmanager
def _manifest_registry(response):
    requests = []

    class Registry(BaseHTTPRequestHandler):
        def respond(self):
            requests.append((self.command, self.path))
            request_body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            reply = response(self.command, self.path, request_body)
            if reply is None:
                self.close_connection = True
                return
            status, body, headers = reply
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        do_GET = respond
        do_POST = respond
        do_PUT = respond

        def log_message(self, *_arguments):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Registry)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=30)
        assert not thread.is_alive()


def test_cold_image_exit_zero_cannot_publish_an_unavailable_actual_manifest(tmp_path):
    completion = tmp_path / "completion.json"
    calls = tmp_path / "builds"
    label = "cloudbench-warm-20261007-120000-123"
    harness = tmp_path / "publish.sh"
    with _manifest_registry(lambda *_request: (404, b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {})) as (
        origin,
        requests,
    ):
        verifier = tmp_path / "verify.py"
        verifier.write_text(
            "import sys,urllib.error,urllib.request\n"
            f"url={origin!r}+'/v2/owned-benchmark-app/manifests/'+sys.argv[4]\n"
            "try:\n"
            "    urllib.request.urlopen(url,timeout=30).close()\n"
            "except urllib.error.HTTPError as error:\n"
            "    raise SystemExit(78 if error.code==404 else 1)\n"
        )
        harness.write_text(
            f"source {shlex.quote(str(PUBLISHER_LIB))}\n"
            f"CLOUDBENCH_IMAGE_COMPLETION_FILE={shlex.quote(str(completion))}\n"
            "CLOUDBENCH_IMAGE_ATTEMPT_APP=owned-benchmark-app\n"
            f"CLOUDBENCH_IMAGE_ATTEMPT_LABEL={label}\n"
            "IMAGE_BUILD_BUILDER=depot\n"
            "IMAGE_PUBLISHER_CLIENT=fixture-publisher\n"
            f"cloudbench_image_publish_child() {{ echo build >> {shlex.quote(str(calls))}; return 0; }}\n"
            f'cloudbench_image_verify_handoff() {{ python3 {shlex.quote(str(verifier))} "$@"; }}\n'
            "cloudbench_image_publish deploy selected-context --build-only --push\n"
        )
        result = subprocess.run([BASH, str(harness)], capture_output=True, text=True, timeout=30)
    assert result.returncode != 0, "Publisher exit zero must not hand an unavailable registry manifest to activation"
    assert requests == [("GET", f"/v2/owned-benchmark-app/manifests/{label}")]
    assert calls.read_text().splitlines() == ["build"]
    if completion.exists():
        assert json.loads(completion.read_text())["publication_verified"] is False


@pytest.mark.parametrize(
    "scenario",
    [
        "available",
        "republish",
        "unavailable",
        "missing-blobs",
        "missing-blobs-settle",
        "missing-blobs-wrong-digest",
        "missing-blobs-digest-missing",
        "invalid-manifest",
        "mixed-manifest-errors",
        "empty-manifest-errors",
        "put-transport-settle",
        "put-auth",
        "digest-missing",
        "wrong-digest",
        "auth",
        "unreconstructable",
        "unanchored",
        "no-digest-header",
        "selected-app",
        "wrong-app",
    ],
)
def test_cold_image_registry_handoff_preserves_exact_manifest_and_consumer_digest(tmp_path, scenario):
    helper = runpy.run_path(str(ROOT / "scripts/lib/cloudbench-image-registry.py"))
    app = "owned-benchmark-app" if scenario == "selected-app" else "navi-whisper-lux-bench"
    image = f"registry.fly.io/{app}:cloudbench-warm-20261007-120000-123"
    tag_path = f"/v2/{app}/manifests/" + image.split(":", 1)[1]
    manifest = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": "sha256:" + "c" * 64, "size": 2},
        "layers": [
            {
                "mediaType": "application/vnd.oci.image.layer.v1.tar+zstd",
                "digest": "sha256:" + str(index) * 64,
                "size": 2,
            }
            for index in range(6)
        ],
    }
    raw = json.dumps(manifest, indent=2).encode()
    digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    digest_path = f"/v2/{app}/manifests/" + digest
    metadata = {**manifest, "annotations": {"fly_builder_id": "fixture-cached-metadata"}}
    if scenario == "unreconstructable":
        metadata["config"] = {**manifest["config"], "digest": "sha256:" + "d" * 64}
    writes = []
    metadata_queries = []
    phase = 0
    elapsed = [0.0]
    blob_errors = [
        {"code": "MANIFEST_BLOB_UNKNOWN", "message": "blob unknown to registry", "detail": layer["digest"]}
        for layer in manifest["layers"]
    ]
    settling = scenario.startswith("missing-blobs-") or scenario == "put-transport-settle"
    put_errors = {
        "invalid-manifest": [{"code": "MANIFEST_INVALID"}],
        "mixed-manifest-errors": [*blob_errors, {"code": "MANIFEST_INVALID"}],
        "empty-manifest-errors": [],
    }

    def fixture_sleep(seconds):
        elapsed[0] += seconds
        assert elapsed[0] < 3600, "Registry fixture exceeded its whole-operation guard"

    def response(method, path, body):
        nonlocal phase
        if method == "POST":
            assert path == "/graphql"
            metadata_queries.append(json.loads(body)["variables"])
            payload = {"data": {"app": {"image": {"digest": digest, "ref": image, "manifest": metadata}}}}
            return 200, json.dumps(payload).encode(), {}
        assert path in {tag_path, digest_path}, "Handoff must not probe config or layer blobs"
        if method == "PUT":
            assert path == tag_path
            writes.append(body)
            if scenario == "put-transport-settle":
                return None
            if scenario == "missing-blobs" or settling:
                return 400, json.dumps({"errors": blob_errors}).encode(), {}
            if scenario in put_errors:
                return 400, json.dumps({"errors": put_errors[scenario]}).encode(), {}
            if scenario == "put-auth":
                return 401, b'{"errors":[{"code":"UNAUTHORIZED"}]}', {}
            phase = 1
            return 201, b"", {"Docker-Content-Digest": digest}
        assert method == "GET"
        if scenario == "auth":
            return 401, b'{"errors":[{"code":"UNAUTHORIZED"}]}', {}
        if (
            scenario in {"unavailable", "missing-blobs", "unreconstructable", "unanchored"}
            or (scenario == "digest-missing" and path == digest_path)
            or scenario in put_errors
            or scenario == "put-auth"
            or (settling and elapsed[0] < 175)
        ):
            return 404, b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {}
        if scenario == "missing-blobs-digest-missing" and path == digest_path:
            return 404, b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {}
        if scenario == "republish" and phase < 2:
            phase += 1
            return 404, b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {}
        header_digest = "sha256:" + "b" * 64 if scenario in {"wrong-digest", "missing-blobs-wrong-digest"} else digest
        return 200, raw, {} if scenario == "no-digest-header" else {"Docker-Content-Digest": header_digest}

    with _manifest_registry(response) as (origin, requests):
        handoff = helper["RegistryHandoff"](
            "fixture-registry-token",
            tmp_path / "private-observations",
            "foreign-benchmark-app" if scenario == "wrong-app" else app,
            registry_origin=origin,
            graphql_origin=origin + "/graphql",
            sleep=fixture_sleep,
            clock=lambda: elapsed[0],
        )
        if scenario in {
            "available",
            "republish",
            "no-digest-header",
            "selected-app",
            "missing-blobs-settle",
            "put-transport-settle",
        }:
            receipt = handoff.verify(image, digest)
            assert receipt["registry_handoff_verified"] is True
            assert receipt["published_image_ref"] == image + "@" + digest
            assert receipt["published_digest"] == digest
            assert receipt["manifest_republished"] is (scenario == "republish")
            assert requests[-2:] == [("GET", tag_path), ("GET", digest_path)]
            assert bool(writes) is (scenario in {"republish", "missing-blobs-settle", "put-transport-settle"})
        else:
            with pytest.raises(helper["HandoffError"]):
                handoff.verify(image, None if scenario == "unanchored" else digest)
            if scenario in {"auth", "wrong-digest", "unanchored"}:
                assert requests == [("GET", tag_path)]
            if scenario == "unreconstructable":
                assert requests == [("GET", tag_path), ("POST", "/graphql")]
            if scenario in put_errors or scenario == "put-auth":
                assert requests == [("GET", tag_path), ("POST", "/graphql"), ("PUT", tag_path)]
                assert elapsed[0] == 0, "Unrelated registry rejections must remain terminal"
            if scenario not in {"unavailable", "missing-blobs", *put_errors, "put-auth"} and not settling:
                assert not writes
    if scenario == "wrong-app":
        assert not requests
    else:
        assert requests[0] == ("GET", tag_path)
    assert all(
        (method == "GET" and path in {tag_path, digest_path})
        or (method == "PUT" and path == tag_path)
        or (method == "POST" and path == "/graphql")
        for method, path in requests
    ), "Handoff must only read the exact manifest routes and republish the exact tag"
    assert all(query == {"appName": app, "imageRef": image} for query in metadata_queries)
    if scenario == "missing-blobs" or settling:
        assert len(metadata_queries) == 1, (
            "The same metadata and authentication must span registry visibility observations"
        )
        assert len(writes) == 1, "A missing-blob rejection must settle through reads without repeating the exact PUT"
        assert elapsed[0] == (180 if scenario in {"missing-blobs", "missing-blobs-digest-missing"} else 175)
    if scenario == "digest-missing":
        assert ("GET", digest_path) in requests
    if scenario in {"unavailable", "missing-blobs"}:
        assert len(writes) == 1, (
            "Cached metadata gets one exact PUT without granting credit for unavailable publication"
        )
    assert all(body == raw for body in writes), "Republication must preserve the original built manifest bytes"
    for artifact in (tmp_path / "private-observations").iterdir():
        assert artifact.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize(
    ("phase", "payload"),
    [
        ("graphql", {"data": None, "errors": [{"message": "private-provider-error"}]}),
        ("graphql", None),
        ("graphql", []),
        ("graphql", {"data": []}),
        ("graphql", {"data": {"app": []}}),
        ("graphql", {"data": {"app": {"image": []}}}),
        ("auth", None),
        ("auth", []),
        ("manifest", {"layers": None}),
        ("manifest", {"layers": 42}),
        ("manifest", {"layers": False}),
        ("manifest", {"layers": {}}),
        ("manifest", {"manifests": None}),
        ("manifest", {"manifests": 42}),
        ("manifest", {"manifests": {}}),
        ("manifest", {"annotations": None}),
        ("manifest", {"annotations": []}),
        ("manifest", {"annotations": 7}),
        ("manifest", {"layers": [{"annotations": []}]}),
        ("manifest", {"manifests": [{"annotations": None}]}),
    ],
)
def test_cold_image_registry_main_invalid_provider_payload_retains_private_failure_receipt(
    tmp_path, monkeypatch, capsys, phase, payload
):
    helper = runpy.run_path(str(ROOT / "scripts/lib/cloudbench-image-registry.py"))
    app = "owned-benchmark-app"
    image = f"registry.fly.io/{app}:cloudbench-warm-20261007-120000-123"
    tag_path = f"/v2/{app}/manifests/" + image.split(":", 1)[1]
    client = tmp_path / "fixture-client"
    auth_payload = payload if phase == "auth" else {"token": "fixture-registry-token"}
    client.write_text("#!/usr/bin/env bash\nprintf '%s\\n' " + shlex.quote(json.dumps(auth_payload)) + "\n")
    client.chmod(0o700)
    output = tmp_path / "handoff.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "registry-handoff",
            "--client",
            str(client),
            "--app",
            app,
            "--image",
            image,
            "--expected-digest",
            "sha256:" + "d" * 64,
            "--out-file",
            str(output),
        ],
    )

    def response(method, path, _body):
        if method == "POST":
            assert path == "/graphql"
            metadata = (
                {"data": {"app": {"image": {"digest": "sha256:" + "d" * 64, "manifest": payload}}}}
                if phase == "manifest"
                else payload
            )
            return 200, json.dumps(metadata).encode(), {}
        assert (method, path) == ("GET", tag_path)
        return 404, b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {}

    original = helper["RegistryHandoff"]
    with _manifest_registry(response) as (origin, requests):
        monkeypatch.setitem(
            helper["main"].__globals__,
            "RegistryHandoff",
            lambda token, path, selected_app: original(
                token, path, selected_app, registry_origin=origin, graphql_origin=origin + "/graphql"
            ),
        )
        assert helper["main"]() == 74
    receipt = json.loads(output.read_text())
    assert receipt["registry_handoff_verified"] is False
    assert receipt["registry_handoff_error"]
    assert output.stat().st_mode & 0o777 == 0o600
    assert requests == ([] if phase == "auth" else [("GET", tag_path), ("POST", "/graphql")])
    emitted = capsys.readouterr()
    assert "Traceback" not in emitted.err
    assert "private-provider-error" not in output.read_text() + emitted.out + emitted.err
    for directory in tmp_path.glob("handoff.json.*.private"):
        assert directory.stat().st_mode & 0o777 == 0o700
        assert all(path.stat().st_mode & 0o777 == 0o600 for path in directory.iterdir())


def test_cold_image_registry_main_keeps_repeated_output_observations_private(tmp_path, monkeypatch):
    helper = runpy.run_path(str(ROOT / "scripts/lib/cloudbench-image-registry.py"))
    image = "registry.fly.io/navi-whisper-lux-bench:cloudbench-warm-20261007-120000-123"
    raw = json.dumps(
        {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "layers": []}
    ).encode()
    digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    client = tmp_path / "fixture-client"
    client.write_text('#!/usr/bin/env bash\nprintf \'{"token":"fixture-registry-token"}\\n\'\n')
    client.chmod(0o700)
    output = tmp_path / "handoff.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "registry-handoff",
            "--client",
            str(client),
            "--app",
            "navi-whisper-lux-bench",
            "--image",
            image,
            "--out-file",
            str(output),
        ],
    )
    original = helper["RegistryHandoff"]
    with _manifest_registry(lambda *_request: (200, raw, {"Docker-Content-Digest": digest})) as (origin, requests):
        monkeypatch.setitem(
            helper["main"].__globals__,
            "RegistryHandoff",
            lambda token, path, selected_app: original(token, path, selected_app, registry_origin=origin),
        )
        assert helper["main"]() == 0
        assert helper["main"]() == 0
    assert json.loads(output.read_text())["published_image_ref"] == image + "@" + digest
    assert len(requests) == 4
    captures = list(tmp_path.glob("handoff.json.*.private"))
    assert len(captures) == 2
    assert output.stat().st_mode & 0o777 == 0o600
    for directory in captures:
        assert directory.stat().st_mode & 0o777 == 0o700
        assert len(list(directory.glob("*.private.body"))) == 2
        assert all(path.stat().st_mode & 0o777 == 0o600 for path in directory.iterdir())


@pytest.mark.parametrize("receipt_state", ["unavailable", "missing", "false", "malformed", "wrong-tag"])
def test_cold_image_unavailable_handoff_stops_the_normal_build_retry(tmp_path, receipt_state):
    source = (ROOT / "scripts/run-bench-cloud").read_text()
    start = source.index("build_warm_image() {")
    end = source.index("\n}\n", start) + 3
    calls = tmp_path / "builds"
    verifier = tmp_path / "verify.py"
    verifier.write_text(
        "import json,sys\n"
        f"state={receipt_state!r}\n"
        "if state=='unavailable':sys.exit(78)\n"
        "if state=='missing':sys.exit(0)\n"
        "path,app,label=sys.argv[2:]\n"
        "digest='sha256:'+'a'*64\n"
        "if state=='wrong-tag':label+='-foreign'\n"
        "with open(path+'.handoff.json','w') as output:\n"
        "    if state=='malformed':output.write('{')\n"
        "    else:json.dump({'registry_handoff_verified':state!='false','published_digest':digest,"
        "'published_image_ref':f'registry.fly.io/{app}:{label}@{digest}'},output)\n"
    )
    harness = tmp_path / "build.sh"
    harness.write_text(
        f"source {shlex.quote(str(PUBLISHER_LIB))}\n"
        "APP=owned-benchmark-app\nIMAGE_BUILD_BUILDER=depot\nIMAGE_BUILD_NO_CACHE=1\nWARM_IMAGE_REF=''\n"
        f"OUT_DIR={shlex.quote(str(tmp_path))}\nIMAGE_BUILD_CONTEXT={shlex.quote(str(tmp_path))}\n"
        "IMAGE_PUBLISHER_CLIENT=fixture-publisher\n"
        f"cloudbench_image_publish_child() {{ echo build >> {shlex.quote(str(calls))}; return 0; }}\n"
        f'cloudbench_image_verify_handoff() {{ python3 {shlex.quote(str(verifier))} "$@"; }}\n'
        "sleep() { :; }\n" + source[start:end] + "\nbuild_warm_image\n"
    )
    result = subprocess.run([BASH, str(harness)], capture_output=True, text=True, timeout=30)
    assert result.returncode != 0
    assert calls.read_text().splitlines() == ["build"], "Registry refusal must not repeat an uncached dependency build"
    assert json.loads((tmp_path / "cloudbench-image-publication.json").read_text())["publication_verified"] is False


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


@pytest.mark.parametrize("initial", ["started", "stopped", "stop-failed"])
def test_cold_image_activation_quiesces_existing_donor_before_environment(tmp_path, initial):
    cloud = (ROOT / "scripts/run-bench-cloud").read_text()
    functions = []
    for name in ("activate_machine_environment", "inject_secrets"):
        start = cloud.index(name + "() {")
        end = cloud.index("\n}\n", start) + 3
        functions.append(cloud[start:end])
    events = tmp_path / "events"
    state = tmp_path / "state"
    state.write_text("stopped" if initial == "stopped" else "started")
    script = (
        "\n".join(functions)
        + r"""
MODE=setup
APP=fixture
CLOUDBENCH_HOLD_APP_ENV_LOCK=1
acquire_app_environment_lock() { echo lock >> "$EVENTS"; LOCKED=1; }
release_app_environment_lock() { echo unlock >> "$EVENTS"; }
assert_app_environment_lock_ownership() { [ "$LOCKED" = 1 ]; }
resolve_machine_id() { echo warm-1; }
environment_activation_targets() { printf 'warm\twarm-1\npool\tpool-1\n'; }
machine_state_for_activation() { [ "$1" = warm-1 ] && cat "$STATE"; }
stop_machine_strict() {
    assert_app_environment_lock_ownership || return 1
    [ "$1" = warm-1 ] || return 1
    echo stop >> "$EVENTS"
    [ "$INITIAL" != stop-failed ] || return 1
    echo stopped > "$STATE"
}
FLY() { echo update >> "$EVENTS"; }
_inject_secrets_locked() {
    echo inject >> "$EVENTS"
    activate_machine_environment warm-1 warm
}
inject_secrets
"""
    )
    result = subprocess.run(
        [BASH, "-c", script],
        env={**os.environ, "EVENTS": str(events), "STATE": str(state), "INITIAL": initial},
        capture_output=True,
        text=True,
        timeout=30,
    )
    observed = events.read_text().splitlines()
    if initial == "stop-failed":
        assert result.returncode != 0
        assert observed == ["lock", "stop", "unlock"], result.stderr
    else:
        assert result.returncode == 0, result.stderr
        assert observed == (["lock", "stop"] if initial == "started" else ["lock"]) + ["inject", "update"]


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
    assert json.loads(observed.read_text()) == [
        "--build-image",
        *options,
        *([] if builder is not None else ["--builder", "depot"]),
    ]


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
    registry = root / "agents/providers/rose/pools.py"
    registry.parent.mkdir(parents=True)
    shutil.copyfile(ROOT / "agents/providers/rose/pools.py", registry)
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
        "cloudbench_image_verify_handoff() {\n"
        'python3 - "$2.handoff.json" "$3" "$4" <<\'PY_HANDOFF\'\n'
        "import json,sys\n"
        "path,app,label=sys.argv[1:]\n"
        "digest='sha256:'+'a'*64\n"
        "with open(path,'w') as output:\n"
        "    json.dump({'registry_handoff_verified':True,'published_digest':digest,"
        "'published_image_ref':f'registry.fly.io/{app}:{label}@{digest}',"
        "'manifest_republished':False,'registry_handoff_attempts':1},output)\n"
        "PY_HANDOFF\n}\n"
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


_STALLED_PUBLISHER = r'''
import hashlib, json, os, sys, time
from pathlib import Path

args = sys.argv[1:]
state = Path(os.environ["IMAGE_TEST_STATE"])
scenario = os.environ["IMAGE_TEST_SCENARIO"]
attempt = len(list(state.glob("attempt-*.json"))) + 1
label = args[args.index("--image-label") + 1]
app = args[args.index("-a") + 1]
(state / f"attempt-{attempt}.json").write_text(json.dumps({"label": label, "pid": os.getpid()}))
image = f"registry.fly.io/{app}:{label}"
manifest = json.dumps({
    "schemaVersion": 2,
    "mediaType": "application/vnd.oci.image.manifest.v1+json",
    "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
               "digest": "sha256:" + str(attempt) * 64, "size": 2},
    "layers": [],
}).encode()
digest = "sha256:" + hashlib.sha256(manifest).hexdigest()

def remote_manifest_put():
    registry = state / "registry"
    registry.mkdir(exist_ok=True)
    sequence = len(list(registry.iterdir()))
    (registry / f"{sequence:03d}.json").write_text(
        json.dumps({"tag": label, "digest": digest, "manifest": manifest.decode()}))

def say(line):
    print(line, flush=True)

say("==> Building image with Depot")
say(f"#25 pushing layers for {image}@{digest}")
if attempt == 1 and scenario in ("remote-eof", "silent-stall"):
    # The remote builder finishes its push, but its BuildKit status stream never
    # reaches this client again (trial 2: manifest 81a55a3f exists in the registry
    # although the client's last line was a pending "pushing layer").
    remote_manifest_put()
    if scenario == "silent-stall":
        time.sleep(3600)
    time.sleep(1)
    say("Error: failed to fetch an image or build from source: error building: failed to receive "
        "status: rpc error: code = Unavailable desc = error reading from server: EOF")
    sys.exit(1)
if scenario == "slow-progress":
    for tick in range(8):
        say(f"#22 {tick * 0.5:.2f} Installing collected packages")
        time.sleep(0.5)
remote_manifest_put()
say(f"#25 pushing manifest for {image}@{digest} 0.3s done")
say("--> Building image done")
'''

_HANDOFF_VERIFIER = r'''
import json, os, runpy, sys, tempfile

out, app, label, log, registry_py, origin = sys.argv[1:]
helper = runpy.run_path(registry_py)
image = f"registry.fly.io/{app}:{label}"
receipt = {"registry_handoff_verified": False}
try:
    expected = helper["publisher_digest"](log, image)
    private = tempfile.mkdtemp(dir=os.path.dirname(out), suffix=".private")
    receipt = helper["RegistryHandoff"](
        "fixture-token", private, app, registry_origin=origin, graphql_origin=origin + "/graphql"
    ).verify(image, expected)
except helper["HandoffError"] as error:
    receipt["registry_handoff_error"] = str(error)
with open(out, "w") as output:
    json.dump(receipt, output)
if not receipt["registry_handoff_verified"]:
    print(receipt["registry_handoff_error"])
    raise SystemExit(74)
'''


@pytest.mark.parametrize("scenario", ["remote-eof", "silent-stall", "slow-progress", "invalid-bound"])
def test_cold_image_stalled_publisher_attempt_retries_under_its_own_tag(tmp_path, scenario):
    """A dead Depot status stream ends its attempt; the retry never reads that attempt's tag.

    Trial 2 (2026-10-12): attempt 1's client printed nothing for 973 s until a remote
    EOF, while its remote builder still published manifest 81a55a3f under the shared
    label. Attempt 2 reused that label, and three seconds after its own manifest PUT
    the registry still returned attempt 1's manifest, so the handoff failed with 74.
    """
    source = (ROOT / "scripts/run-bench-cloud").read_text()
    start = source.index("build_warm_image() {")
    end = source.index("# MODE: --setup", start)
    context = tmp_path / "selected checkout"
    context.mkdir()
    (context / "Dockerfile.cloudbench-warm").write_text("FROM fixture\n")
    (context / "fly.cloudbench-warm.toml").write_text('app = "fixture"\n')
    output = tmp_path / "receipt"
    output.mkdir()
    state = tmp_path / "state"
    state.mkdir()
    publisher = tmp_path / "publisher.py"
    publisher.write_text(f"#!{sys.executable}\n" + _STALLED_PUBLISHER)
    publisher.chmod(0o700)
    verifier = tmp_path / "verify.py"
    verifier.write_text(_HANDOFF_VERIFIER)

    def writes():
        registry = state / "registry"
        return [json.loads(path.read_text()) for path in sorted(registry.iterdir())] if registry.is_dir() else []

    def response(method, path, _body):
        if method != "GET":
            return 404, b'{"errors":[{"code":"UNSUPPORTED"}]}', {}
        ref = path.rsplit("/manifests/", 1)[1]
        if ref.startswith("sha256:"):
            matches = [write for write in writes() if write["digest"] == ref]
        else:
            # Read-after-write lag observed at 22:17:53Z: the tag still served the
            # earlier manifest three seconds after the retry's own manifest PUT.
            matches = [write for write in writes() if write["tag"] == ref][:1]
        if not matches:
            return 404, b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {}
        return 200, matches[0]["manifest"].encode(), {"Docker-Content-Digest": matches[0]["digest"]}

    with _manifest_registry(response) as (origin, _requests):
        harness = tmp_path / "build.sh"
        harness.write_text(
            "set -e\nAPP=owned-benchmark-app\nMODE=build-image\n"
            f"ROOT_DIR={shlex.quote(str(ROOT))}\n"
            f"IMAGE_BUILD_CONTEXT={shlex.quote(str(context))}\n"
            f"OUT_DIR={shlex.quote(str(output))}\nIMAGE_BUILD_NO_CACHE=1\nWARM_IMAGE_REF=''\n"
            "IMAGE_BUILD_BUILDER=depot\n"
            f"source {shlex.quote(str(ROOT / 'scripts/lib/cloudbench-env.sh'))}\n"
            f"source {shlex.quote(str(PUBLISHER_LIB))}\n"
            f"cloudbench_image_publisher_client() {{ printf '%s\\n' {shlex.quote(str(publisher))}; }}\n"
            "cloudbench_image_verify_handoff() {\n"
            f'  python3 {shlex.quote(str(verifier))} "$2.handoff.json" "$3" "$4" '
            f'"$CLOUDBENCH_IMAGE_PUBLISHER_LOG" {shlex.quote(str(ROOT / "scripts/lib/cloudbench-image-registry.py"))} '
            f"{shlex.quote(origin)}\n}}\n"
            "sleep() { :; }\n" + source[start:end]
        )
        env = {
            **os.environ,
            "IMAGE_TEST_STATE": str(state),
            "IMAGE_TEST_SCENARIO": scenario,
            "CLOUDBENCH_IMAGE_PUBLISH_IDLE_SECONDS": {"remote-eof": "30", "invalid-bound": "0"}.get(scenario, "2"),
        }
        process = subprocess.Popen(
            [BASH, str(harness)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=90)
        except subprocess.TimeoutExpired:
            # Fixture-owned session only: the harness started its own process group.
            os.killpg(process.pid, 9)
            process.communicate(timeout=30)
            pytest.fail("A publisher attempt without output held the image build until the fixture deadline")

    attempts = [json.loads(path.read_text()) for path in sorted(state.glob("attempt-*.json"))]
    if scenario == "invalid-bound":
        assert process.returncode != 0
        assert attempts == [], "An invalid no-output bound must fail before launching the provider"
        return
    assert process.returncode == 0, stdout + stderr
    receipt = json.loads((output / "cloudbench-image-build.json").read_text())
    assert receipt["publication_verified"] is True
    final = writes()[-1]
    assert receipt["image_ref"] == f"registry.fly.io/owned-benchmark-app:{attempts[-1]['label']}@{final['digest']}"
    labels = [attempt["label"] for attempt in attempts]
    assert len(set(labels)) == len(labels), f"retries reused a mutable registry tag: {labels}"
    for attempt in attempts:
        try:
            os.kill(attempt["pid"], 0)
        except ProcessLookupError:
            continue
        state_letter = subprocess.run(
            ["ps", "-p", str(attempt["pid"]), "-o", "stat="], capture_output=True, text=True
        ).stdout.strip()
        assert state_letter.startswith("Z") or not state_letter, f"attempt process survived: {attempt}"
    if scenario == "slow-progress":
        assert receipt["build_attempts"] == 1, "Continuing output must never be treated as a stall"
        return
    assert receipt["build_attempts"] == 2
    if scenario == "silent-stall":
        assert "no output for 2s" in stderr
        first_log = next(
            path for path in output.glob("*.private.log") if labels[0] in path.read_text()
        )
        assert first_log.read_text().rstrip().endswith("ending this attempt for the normal retry.")
    for private in output.glob("*.private.log"):
        assert private.stat().st_mode & 0o777 == 0o600


_TERMINAL_PROGRESS_PUBLISHER = r'''
import json, os, signal, subprocess, sys, time
from pathlib import Path

state = Path(os.environ["IMAGE_TEST_STATE"])
scenario = os.environ["IMAGE_TEST_SCENARIO"]
metadata = {
    "pid": os.getpid(), "stderr_tty": os.isatty(2), "stdout_tty": os.isatty(1),
    "stdin_tty": os.isatty(0), "stdin_closed": sys.stdin.buffer.read(1) == b"",
}
if scenario in ("silent", "cancel"):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(3600)"])
    metadata["descendant_pid"] = child.pid
(state / "invocation.json").write_text(json.dumps(metadata))
if metadata["stdin_tty"] or metadata["stdout_tty"] or not metadata["stdin_closed"]:
    raise SystemExit(92)
print("fixture-layer: Preparing", file=sys.stderr, flush=True)
if scenario in ("silent", "cancel"):
    time.sleep(3600)
if scenario == "exit":
    raise SystemExit(37)
if scenario == "signal":
    os.kill(os.getpid(), signal.SIGTERM)
for current in range(1, 17):
    # The fixture's independent event sink proves actual transfer events continue
    # even when Docker v28.5.2's nonterminal renderer suppresses progressDetail.
    with (state / "actual-progress.jsonl").open("a") as output:
        output.write(json.dumps({"id": "fixture-layer", "current": current, "total": 16}) + "\n")
    if os.isatty(2) or os.environ["IMAGE_TEST_BUILDER"] == "depot":
        print(f"fixture-layer: Pushing {current}/16", file=sys.stderr, flush=True)
    time.sleep(0.3)
print("fixture-layer: Pushed", file=sys.stderr, flush=True)
'''


def _terminal_progress_harness(tmp_path, builder, scenario):
    state = tmp_path / "state"
    state.mkdir()
    publisher = tmp_path / "publisher.py"
    publisher.write_text(f"#!{sys.executable}\n" + _TERMINAL_PROGRESS_PUBLISHER)
    publisher.chmod(0o700)
    log = tmp_path / "publisher.private.log"
    log.touch(mode=0o600)
    harness = tmp_path / "publish.sh"
    harness.write_text(
        f"source {shlex.quote(str(ROOT / 'scripts/lib/cloudbench-env.sh'))}\n"
        f"source {shlex.quote(str(PUBLISHER_LIB))}\n"
        f"IMAGE_BUILD_BUILDER={builder}\n"
        f"cloudbench_image_publish_watched {shlex.quote(str(log))} {shlex.quote(str(publisher))} &\n"
        "owner=$!\n"
        "trap 'cloudbench_terminate_tree_and_wait 3 \"$owner\"; exit 143' TERM\n"
        'wait "$owner"\n'
    )
    process = subprocess.Popen(
        [BASH, str(harness)],
        env={**os.environ, "IMAGE_TEST_STATE": str(state), "IMAGE_TEST_SCENARIO": scenario,
             "IMAGE_TEST_BUILDER": builder, "CLOUDBENCH_IMAGE_PUBLISH_IDLE_SECONDS": "2"},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
    )
    return process, state, log


def _assert_terminal_fixture_pid(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    status = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert not status or status.startswith("Z"), f"fixture-owned process survived: {pid} {status}"


@pytest.mark.parametrize("builder", ["native", "depot"])
def test_cold_image_native_terminal_progress_reaches_actual_watchdog(tmp_path, builder):
    process, state, log = _terminal_progress_harness(tmp_path, builder, "progress")
    stdout, stderr = process.communicate(timeout=30)
    events = [json.loads(line) for line in (state / "actual-progress.jsonl").read_text().splitlines()]
    assert len(events) >= 3, "Fixture must actually make progress before any timeout"
    assert process.returncode == 0, stdout + stderr
    assert [event["current"] for event in events] == list(range(1, 17))
    assert "Pushing 1/16" in log.read_text() and "Pushing 16/16" in log.read_text()
    assert "no output" not in stderr
    invocation = json.loads((state / "invocation.json").read_text())
    assert invocation["stderr_tty"] is (builder == "native")
    assert invocation["stdout_tty"] is False and invocation["stdin_tty"] is False
    assert invocation["stdin_closed"] is True
    _assert_terminal_fixture_pid(invocation["pid"])


@pytest.mark.parametrize("scenario,expected", [("silent", 124), ("exit", 37), ("signal", 143), ("cancel", 143)])
def test_cold_image_native_terminal_progress_preserves_failure_and_cleanup(tmp_path, scenario, expected):
    process, state, log = _terminal_progress_harness(tmp_path, "native", scenario)
    if scenario == "cancel":
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "condition_wait", Path(__file__).resolve().parents[2] / "scripts" / "lib" / "condition_wait.py")
        condition_wait = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(condition_wait)
        # Cancel only after the actual publisher starts.
        condition_wait.wait_until(lambda: (state / "invocation.json").exists(), timeout=10,
                                  description="publisher fixture started")
        process.terminate()
    stdout, stderr = process.communicate(timeout=45)
    assert process.returncode == expected, stdout + stderr
    invocation = json.loads((state / "invocation.json").read_text())
    assert invocation["stdin_closed"] is True
    _assert_terminal_fixture_pid(invocation["pid"])
    if "descendant_pid" in invocation:
        _assert_terminal_fixture_pid(invocation["descendant_pid"])
    if scenario == "silent":
        assert "no output for 2s" in stderr
        assert "Pushing" not in log.read_text()
