"""Actual seed owner/overlay boundaries; synthetic file, no database or network."""

import asyncio
import json
import os
import subprocess
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

import pytest

import benchmarks.run_benchmark as rb
from benchmarks.fixture_host_guard import FIXTURE_HOST_GUARD_SECONDS

TARGET = "postgresql://postgres:fixture@localhost:55005/victoria"
SOURCE = "postgresql://fixture@source.invalid/victoria"


def environment(tmp_path, *, explicit=True, valid=True, seed_ok=True):
    stack = ExitStack()
    auth = tmp_path / "auth.json"
    auth.write_text(
        json.dumps(
            {
                "auth_mode": "chatgpt",
                "tokens": {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"},
            }
        )
        if valid
        else "{bad-json"
    )
    auth.chmod(0o600)
    env = {"CODEX_AUTH_PATH": str(auth)} if explicit else {}
    stack.enter_context(patch.dict(os.environ, env, clear=True))
    stack.enter_context(patch.object(rb.sys, "platform", "linux"))
    stack.enter_context(patch.object(rb, "_local_victoria_database_url", return_value=TARGET))
    stack.enter_context(patch.object(rb, "_compute_token_source_database_url", return_value=(SOURCE, "fixture source")))
    stack.enter_context(patch.object(rb, "load_env_var", return_value="synthetic-encryption-key"))
    stack.enter_context(patch.object(rb, "_has_usable_anthropic_api_key_fallback", new=AsyncMock(return_value=True)))
    stack.enter_context(patch.object(rb, "_refresh_local_claude_token_from_keychain", return_value=False))
    stack.enter_context(patch.object(rb, "_sync_email_credentials", return_value=True))
    stack.enter_context(patch.object(rb, "_sync_browser_credentials", return_value=True))
    stack.enter_context(patch.object(rb, "_assert_live_cookie_domains_usable"))
    calls = []
    state = {"credential": "before"}

    def process(command, *, env, **kwargs):
        assert env["DATABASE_URL"] == TARGET and env["DIRECT_URL"] == TARGET
        if command == ["npx", "tsx", "scripts/seed-local.ts", "--compute-tokens-only"]:
            assert env["SEED_COMPUTE_TOKEN_SOURCE_DATABASE_URL"] == SOURCE
            calls.append("seed")
            state["credential"] = "captured-stale-source-lineage"
            return subprocess.CompletedProcess(command, 0 if seed_ok else 1, "", "")
        assert command == ["npx", "tsx", "scripts/sync-codex-token.ts"]
        assert env["CODEX_AUTH_PATH"] == str(auth)
        assert env["CODEX_TOKEN_POOLING_ENABLED"] == "true"
        calls.append("overlay")
        if not valid:
            return subprocess.CompletedProcess(command, 1, "", "Codex auth file is not valid JSON.")
        state["credential"] = "explicit-current-authority"
        return subprocess.CompletedProcess(command, 0, "", "")

    stack.enter_context(patch.object(rb, "_run_seed_subprocess", side_effect=process))
    return stack, calls, state, auth


def test_linux_explicit_file_reaches_existing_sync_owner(tmp_path):
    stack, calls, state, _ = environment(tmp_path)
    with stack:
        assert rb._refresh_local_gpt_token_from_codex_auth(TARGET)
    assert calls == ["overlay"]


def test_mixed_preflight_then_live_seed_preserves_explicit_authority(tmp_path):
    stack, calls, state, _ = environment(tmp_path)
    with stack:
        asyncio.run(rb._refresh_local_compute_tokens_for_run("http://127.0.0.1:3999"))
        assert state["credential"] == "explicit-current-authority"
        rb._apply_live_fixture(
            rb.LiveFixtureContext(base_url="http://127.0.0.1:3999", user_id=rb.USER_ID, auth_realm="local")
        )
        assert state["credential"] == "explicit-current-authority"
    assert calls == ["seed", "overlay", "seed", "overlay"]


def test_explicit_invalid_authority_fails_closed_at_seed_owner(tmp_path):
    stack, calls, state, _ = environment(tmp_path, valid=False)
    with stack, pytest.raises(RuntimeError, match="Codex|GPT"):
        rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True)


def test_explicit_missing_authority_fails_closed(tmp_path):
    stack, calls, state, auth = environment(tmp_path)
    auth.unlink()
    with stack, pytest.raises(RuntimeError, match="Codex|GPT"):
        rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True)


def test_no_explicit_authority_keeps_linux_seed_behavior(tmp_path):
    stack, calls, state, _ = environment(tmp_path, explicit=False)
    with stack:
        asyncio.run(rb._refresh_local_compute_tokens_for_run("http://127.0.0.1:3999"))
    assert calls == ["seed"]
    assert state["credential"] == "captured-stale-source-lineage"


def test_remote_target_does_not_import_local_auth(tmp_path):
    stack, calls, state, _ = environment(tmp_path)
    with stack:
        asyncio.run(rb._refresh_local_compute_tokens_for_run("https://api.roselabs.ai"))
    assert not calls


def test_failed_source_seed_never_runs_overlay(tmp_path):
    stack, calls, state, _ = environment(tmp_path, seed_ok=False)
    with stack:
        assert rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True) is False
    assert calls == ["seed"]


@pytest.fixture
def handoff(tmp_path, monkeypatch):
    import importlib.util
    from pathlib import Path

    helper = Path(
        os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_HELPER", str(rb.REPO_ROOT / "scripts/cloudbench-codex-auth.py"))
    )
    spec = importlib.util.spec_from_file_location("owned_codex_handoff", helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = tmp_path / "private-handoff"
    monkeypatch.setenv("FLY_MACHINE_ID", "1234567890abcd")
    monkeypatch.setenv("CLOUDBENCH_RUN_TOKEN", "exact-run-1")
    body = json.dumps(
        {"auth_mode": "chatgpt", "tokens": {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"}}
    ).encode()
    import hashlib

    owner = module.authority("exact-run-1", "1234567890abcd", hashlib.sha256(body).hexdigest())
    return module, owner, body


@pytest.mark.parametrize("mode", ["symlink", "directory", "fifo", "readable", "empty", "large", "malformed"])
def test_explicit_codex_handoff_rejects_unsafe_source(tmp_path, handoff, mode):
    module, _, body = handoff
    source = tmp_path / "source"
    source.write_bytes(body)
    source.chmod(0o600)
    if mode == "symlink":
        source.rename(tmp_path / "target")
        source.symlink_to(tmp_path / "target")
    elif mode in ("directory", "fifo"):
        source.unlink()
        source.mkdir() if mode == "directory" else os.mkfifo(source, 0o600)
    elif mode == "readable":
        source.chmod(0o644)
    elif mode == "empty":
        source.write_bytes(b"")
    elif mode == "large":
        source.write_bytes(b"a" * (module.MAX_BYTES + 1))
    elif mode == "malformed":
        source.write_bytes(b"{broken-json")
    output = tmp_path / "output"
    with pytest.raises((OSError, ValueError)):
        module.prepare(source, output)
    assert not output.exists()


def test_explicit_codex_handoff_prepares_exact_private_immutable_copy(tmp_path, handoff):
    import hashlib
    import stat

    module, _, body = handoff
    source = tmp_path / "source"
    source.write_bytes(body)
    source.chmod(0o600)
    output = tmp_path / "output"
    assert module.prepare(source, output) == hashlib.sha256(body).hexdigest()
    source.write_bytes(b"changed-after-capture")
    assert output.read_bytes() == body
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    with pytest.raises(FileExistsError):
        module.prepare(output, output)


@pytest.mark.parametrize("field,value", [("FLY_MACHINE_ID", "fedcba09876543"), ("CLOUDBENCH_RUN_TOKEN", "sibling")])
def test_explicit_codex_handoff_rejects_wrong_guest(handoff, monkeypatch, field, value):
    module, owner, _ = handoff
    monkeypatch.setenv(field, value)
    with pytest.raises(ValueError, match="identity mismatch"):
        module.authority(owner["run_token"], owner["machine_id"], owner["sha256"])
    assert not module.ROOT.exists()


@pytest.mark.parametrize("token", ["../outside", "a/b", ".", "..", "a\nexport", ""])
def test_explicit_codex_handoff_rejects_path_escape(handoff, token):
    module, owner, _ = handoff
    with pytest.raises(ValueError, match="run identity"):
        module.authority(token, owner["machine_id"], owner["sha256"])


def test_explicit_codex_handoff_waits_for_atomic_complete_upload(handoff):
    import concurrent.futures
    import pwd
    import time

    module, owner, body = handoff
    module.WAIT_SECONDS = 10
    module.admit(owner, "a" * 64)
    module.stage(owner)
    target = module.directory(owner)
    pending = target / "auth.pending"
    pending.write_bytes(body[:9])
    pending.chmod(0o600)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        waiting = executor.submit(module.wait_ready, owner, pwd.getpwuid(os.getuid()).pw_name, "a" * 64)
        time.sleep(0.05)
        assert not waiting.done()
        assert not (target / "auth.json").exists()
        pending.write_bytes(body)
        module.publish(owner)
        assert waiting.result(timeout=10) == target / "auth.json"
    assert not pending.exists()
    assert module.check_ready(owner).read_bytes() == body
    module.retire(owner, "a" * 64)
    assert not target.exists()


@pytest.mark.parametrize("mode", ["wrong-digest", "symlink-pending", "symlink-directory", "wrong-owner"])
def test_explicit_codex_handoff_rejects_ambiguous_publication(tmp_path, handoff, mode):
    module, owner, body = handoff
    module.admit(owner, "a" * 64)
    module.stage(owner)
    target = module.directory(owner)
    pending = target / "auth.pending"
    pending.write_bytes(body)
    pending.chmod(0o600)
    if mode == "wrong-digest":
        pending.write_bytes(body + b" ")
    elif mode == "symlink-pending":
        pending.rename(tmp_path / "other")
        pending.symlink_to(tmp_path / "other")
    elif mode == "symlink-directory":
        target.rename(tmp_path / "other")
        target.symlink_to(tmp_path / "other")
    else:
        (target / "owner.json").write_text(json.dumps({**owner, "run_token": "sibling"}))
    with pytest.raises((OSError, ValueError)):
        module.publish(owner)
    assert not (target / "auth.json").exists()


def test_explicit_codex_handoff_deadline_does_not_accept_pending(handoff):
    module, owner, _ = handoff
    module.admit(owner, "a" * 64)
    module.stage(owner)
    module.WAIT_SECONDS = 0
    with pytest.raises(TimeoutError):
        module.wait_ready(owner, "unused-before-ready", "a" * 64)
    assert (module.directory(owner) / "owner.json").exists()


def test_explicit_codex_handoff_retirement_is_exact(handoff):
    module, owner, body = handoff
    module.admit(owner, "a" * 64)
    module.stage(owner)
    sibling = {**owner, "run_token": "sibling-run"}
    module.admit(sibling, "b" * 64)
    module.stage(sibling)
    target = module.directory(owner)
    pending = target / "auth.pending"
    pending.write_bytes(body)
    pending.chmod(0o600)
    module.publish(owner)
    module.retire(owner, "a" * 64)
    assert not target.exists()
    assert (module.directory(sibling) / "owner.json").exists()


@pytest.mark.parametrize("mode", ["complete", "absent", "partial", "wrong-run", "repeat"])
def test_explicit_codex_actual_controller_sftp_boundary(tmp_path, handoff, mode):
    import hashlib
    import shlex
    from pathlib import Path

    module, owner, body = handoff
    cloud = Path(
        os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_CLOUD", str(rb.REPO_ROOT / "scripts/run-bench-cloud"))
    ).read_text()
    begin = cloud.index("stage_explicit_codex_auth() {")
    finish = cloud.index("\n}\n", begin) + 3
    function = cloud[begin:finish]
    helper = tmp_path / "helper.py"
    actual_helper = Path(
        os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_HELPER", str(rb.REPO_ROOT / "scripts/cloudbench-codex-auth.py"))
    )
    helper.write_text(
        "import runpy\nfrom pathlib import Path\ns=runpy.run_path("
        + repr(str(actual_helper))
        + ')\ns["main"].__globals__["ROOT"]=Path('
        + repr(str(module.ROOT))
        + ')\nimport pwd,os\ns["main"].__globals__["pwd"].getpwnam=lambda user:pwd.getpwuid(os.getuid())\ns["main"]()\n'
    )
    log = tmp_path / "bench.log"
    log.write_text("RUNSTAMP-" + ("sibling" if mode == "wrong-run" else owner["run_token"]) + "\n")
    source = tmp_path / "source.json"
    source.write_bytes(body)
    source.chmod(0o600)
    fake = tmp_path / "flyctl"
    fake.write_text("""#!/usr/bin/env python3
import json,os,pathlib,shlex,subprocess,sys
args=sys.argv[1:]
assert args[:2] in (['ssh','console'],['ssh','sftp'])
assert args[args.index('-a')+1]=='owned-fixture-app'
assert args[args.index('--machine')+1]==os.environ['FLY_MACHINE_ID']
with open(os.environ['CALLS'],'a') as f:f.write(json.dumps(args)+'\\n')
if args[1]=='console':
 command=args[args.index('-C')+1]
 command=command.replace('/data/bench.log',os.environ['BENCH_LOG'])
 command=command.replace('/cloudbench-codex-auth.py',os.environ['ACTUAL_HELPER'])
 if os.environ['MODE']=='wrong-run':
  # Collapse only retry time in this negative fixture; one real rejection is enough.
  result=subprocess.run(shlex.split(command),env=os.environ,timeout=5)
  pathlib.Path(os.environ['REJECTED']).write_text(str(result.returncode))
  raise SystemExit(0)
 raise SystemExit(subprocess.run(shlex.split(command),env=os.environ,timeout=5).returncode)
assert args[:3]==['ssh','sftp','put'] and args[args.index('-m')+1]=='0600'
source=pathlib.Path(args[-2]);destination=pathlib.Path(args[-1].replace('/tmp/rose-cloudbench-codex',os.environ['AUTH_ROOT']))
raw=source.read_bytes()
if os.environ['MODE']=='partial':raw=raw[:9]
destination.write_bytes(raw);destination.chmod(0o600)
raise SystemExit(1 if os.environ['MODE']=='partial' else 0)
""")
    fake.chmod(0o755)
    if mode != "absent":
        module.admit(owner, "a" * 64)
    if mode == "repeat":
        import pwd

        pending = module.directory(owner) / "auth.pending"
        pending.write_bytes(body)
        pending.chmod(0o600)
        module.publish(owner)
        module.wait_ready(owner, pwd.getpwuid(os.getuid()).pw_name, "a" * 64)
    calls = tmp_path / "calls.jsonl"
    rejected = tmp_path / "rejected"
    env = dict(
        os.environ,
        PATH=str(tmp_path) + os.pathsep + os.environ["PATH"],
        CALLS=str(calls),
        BENCH_LOG=str(log),
        ACTUAL_HELPER=str(helper),
        AUTH_ROOT=str(module.ROOT),
        MODE=mode,
        REJECTED=str(rejected),
    )
    command = "set -euo pipefail\n" + _archived_generation_transport(cloud) + function
    command += '\n_with_timeout() { shift; "$@"; }\n'
    command += "APP=owned-fixture-app\nmid=" + owner["machine_id"] + "\nRUN_LOG_TOKEN=" + owner["run_token"] + "\n"
    command += (
        "OUT_DIR="
        + shlex.quote(str(tmp_path))
        + "\nCODEX_AUTH_SOURCE="
        + shlex.quote("" if mode == "absent" else str(source))
        + "\nCODEX_AUTH_SHA256="
        + hashlib.sha256(body).hexdigest()
        + "\n"
    )
    if mode == "wrong-run":
        # Exercise actual remote guard once; prevent a successful fake admission from reaching put.
        command = command.replace(
            '_with_timeout() { shift; "$@"; }', '_with_timeout() { shift; "$@"; [ ! -e "$REJECTED" ] || exit 19; }'
        )
    command += "stage_explicit_codex_auth /cloudbench-codex-auth.py\n"
    import signal

    process = subprocess.Popen(
        ["bash", "-c", command],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
    except BaseException:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise
    result = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
    assert "synthetic-access" not in result.stdout + result.stderr
    if mode in ("complete", "repeat"):
        assert result.returncode == 0, result.stderr + (tmp_path / "cloudbench-codex-stage.log").read_text()
        assert module.check_ready(owner).read_bytes() == body
        assert len(calls.read_text().splitlines()) == (1 if mode == "repeat" else 3)
    elif mode == "absent":
        assert result.returncode == 0
        assert not calls.exists()
    else:
        assert result.returncode != 0
        assert not (module.directory(owner) / "auth.json").exists()
        if mode == "wrong-run":
            assert int(rejected.read_text()) != 0
    if calls.exists():
        assert body.decode() not in calls.read_text()


def test_explicit_codex_never_enters_actual_boot_payload(tmp_path):
    import base64
    import gzip
    import hashlib
    import re
    from pathlib import Path

    cloud = Path(
        os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_CLOUD", str(rb.REPO_ROOT / "scripts/run-bench-cloud"))
    ).read_text()
    block = cloud[cloud.index("    _boot_file_args=(") : cloud.index("    boot_config_payload_guard() {")]
    env = dict(os.environ)
    for name, kind, path in re.findall(
        r'^(CLOUDBENCH_GUEST_\w+)="\$CLOUDBENCH_RUNTIME_(SCRIPT|LIB)_ROOT/([^"\n]+)"', cloud, re.MULTILINE
    ):
        env[name] = str(rb.REPO_ROOT / "scripts" / ("lib" if kind == "LIB" else "") / path)
    env["CLOUDBENCH_GUEST_CODEX_AUTH_SCRIPT"] = os.environ.get(
        "CLOUDBENCH_CODEX_AUTH_TEST_HELPER", str(rb.REPO_ROOT / "scripts/cloudbench-codex-auth.py")
    )
    private = tmp_path / "private-auth.json"
    raw = b'{"auth_mode":"chatgpt","tokens":{"access_token":"private-marker-ACCESS","refresh_token":"private-marker-REFRESH"}}'
    private.write_bytes(raw)
    private.chmod(0o600)
    env.update(
        OUT_DIR=str(tmp_path),
        LOCAL_PATCH_FILE="",
        CLOUDBENCH_REQUIRE_EXECUTION_PROVENANCE="0",
        DASHBOARD="0",
        CODEX_AUTH_SOURCE=str(private),
        CODEX_AUTH_SHA256=hashlib.sha256(raw).hexdigest(),
    )
    command = (
        "set -euo pipefail\n_envargs=()\n"
        + _archived_generation_transport(cloud)
        + block
        + '\nprintf "%s\\n" "${_boot_file_args[@]}"\n'
    )
    result = subprocess.run(["bash", "-c", command], env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    envelope = json.loads(gzip.decompress((tmp_path / "cloudbench-boot-payload.json.gz").read_bytes()))
    assert "cloudbench-codex-auth.py" in envelope["files"]
    for value in envelope["files"].values():
        decoded = base64.b64decode(value, validate=True)
        assert raw not in decoded
        assert b"private-marker-ACCESS" not in decoded
    assert str(private) not in result.stdout
    assert "private-marker-ACCESS" not in result.stdout + result.stderr


@pytest.mark.parametrize("boundary", ["base", "run", "source", "pending", "owner"])
def test_explicit_codex_handoff_rejects_foreign_ownership(tmp_path, handoff, monkeypatch, boundary):
    from pathlib import Path
    from types import SimpleNamespace

    module, owner, body = handoff
    module.admit(owner, "a" * 64)
    module.stage(owner)
    target = module.directory(owner)
    source = tmp_path / "source"
    source.write_bytes(body)
    source.chmod(0o600)
    pending = target / "auth.pending"
    pending.write_bytes(body)
    pending.chmod(0o600)
    selected = {
        "base": module.ROOT,
        "run": target,
        "source": source,
        "pending": pending,
        "owner": target / "owner.json",
    }[boundary]
    actual = selected.stat()
    original_lstat = Path.lstat
    original_fstat = os.fstat

    def foreign(metadata):
        return SimpleNamespace(
            **{
                key: getattr(metadata, key)
                for key in ("st_mode", "st_size", "st_dev", "st_ino", "st_mtime_ns", "st_ctime_ns")
            },
            st_uid=os.geteuid() + 1,
        )

    def lstat(path, *args, **kwargs):
        metadata = original_lstat(path, *args, **kwargs)
        return foreign(metadata) if path == selected else metadata

    def fstat(descriptor):
        metadata = original_fstat(descriptor)
        return foreign(metadata) if (metadata.st_dev, metadata.st_ino) == (actual.st_dev, actual.st_ino) else metadata

    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(os, "fstat", fstat)
    with pytest.raises(ValueError):
        if boundary == "source":
            module.prepare(source, tmp_path / "copy")
        elif boundary == "pending":
            module.publish(owner)
        else:
            module.stage(owner)
    assert not (target / "auth.json").exists()


def test_explicit_codex_authority_never_targets_remote_database(tmp_path):
    stack, calls, _, _ = environment(tmp_path)
    with (
        stack,
        patch.object(rb, "_local_victoria_database_url", return_value=SOURCE),
        pytest.raises(RuntimeError, match="loopback"),
    ):
        rb._sync_compute_tokens(tolerate_gpt_code_unavailable=True)
    assert not calls


def test_explicit_codex_freeze_ignores_artifact_tmpdir(tmp_path):
    from pathlib import Path

    cloud = Path(
        os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_CLOUD", str(rb.REPO_ROOT / "scripts/run-bench-cloud"))
    ).read_text()
    begin = cloud.index('CODEX_AUTH_SOURCE=""')
    end = cloud.index("\nstage_explicit_codex_auth()", begin)
    block = cloud[begin:end]
    source = tmp_path / "authority.json"
    source.write_text(
        json.dumps({"auth_mode": "chatgpt", "tokens": {"access_token": "synthetic", "refresh_token": "synthetic"}})
    )
    source.chmod(0o600)
    helper = os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_HELPER", str(rb.REPO_ROOT / "scripts/cloudbench-codex-auth.py"))
    command = (
        "set -euo pipefail\nSTAGED_LOCAL_FILES=()\ntrap 'rm -f \"${STAGED_LOCAL_FILES[@]}\"' EXIT\n"
        + block
        + '\nprintf "%s\\n" "$CODEX_AUTH_SOURCE"\n'
    )
    result = subprocess.run(
        ["bash", "-c", command],
        env={
            **os.environ,
            "TMPDIR": str(tmp_path),
            "CODEX_AUTH_PATH": str(source),
            "CLOUDBENCH_GUEST_CODEX_AUTH_SCRIPT": helper,
        },
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 0, result.stderr
    staged = Path(result.stdout.strip())
    assert staged.parent.resolve() == Path("/tmp").resolve()
    assert tmp_path not in staged.parents
    assert not staged.exists()


def test_explicit_codex_stage_never_creates_or_resurrects_admission(handoff):
    module, owner, _ = handoff
    with pytest.raises((OSError, ValueError)):
        module.stage(owner)
    assert not module.ROOT.exists()
    module.admit(owner, "a" * 64)
    module.retire(owner, "a" * 64)
    with pytest.raises((OSError, ValueError)):
        module.stage(owner)
    assert not module.directory(owner).exists()


def test_explicit_codex_foreign_driver_cannot_retire_admission(handoff):
    module, owner, _ = handoff
    module.admit(owner, "a" * 64)
    with pytest.raises(ValueError, match="admission"):
        module.retire(owner, "b" * 64)
    assert (module.directory(owner) / "owner.json").exists()


@pytest.mark.parametrize("replacement", ["fifo", "regular"])
def test_explicit_codex_publication_keeps_validated_identity(handoff, monkeypatch, replacement):
    module, owner, body = handoff
    module.admit(owner, "a" * 64)
    target = module.directory(owner)
    pending = target / "auth.pending"
    pending.write_bytes(body)
    pending.chmod(0o600)
    original = os.fsync
    changed = False

    def replace_at_flush(descriptor):
        nonlocal changed
        metadata = os.fstat(descriptor)
        if not changed and metadata.st_ino == pending.stat().st_ino:
            changed = True
            pending.unlink()
            if replacement == "fifo":
                os.mkfifo(pending, 0o600)
            else:
                pending.write_bytes(body + b" ")
                pending.chmod(0o600)
        return original(descriptor)

    monkeypatch.setattr(os, "fsync", replace_at_flush)
    with pytest.raises(ValueError, match="identity changed"):
        module.publish(owner)
    assert changed
    assert not (target / "auth.json").exists()


def test_explicit_codex_shell_launch_precedes_upload_and_requires_cleanup():
    from pathlib import Path

    cloud = Path(
        os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_CLOUD", str(rb.REPO_ROOT / "scripts/run-bench-cloud"))
    ).read_text()
    legacy = cloud.index('launch_attempts="${CLOUDBENCH_DRIVER_LAUNCH_ATTEMPTS:-4}"')
    upload = cloud.index("stage_explicit_codex_auth /data/cloudbench-codex-auth.py")
    assert legacy < upload
    begin = cloud.index("confirm_guest_shutdown() {")
    end = cloud.index("\n}", begin) + 2
    function = cloud[begin:end]
    for explicit in ("", "a" * 64):
        with __import__("tempfile").TemporaryDirectory() as d:
            command = (
                "set -u\n"
                + function
                + "\ncloudbench_skip_held_driver_teardown_race() { return 0; }\nconfirm_guest_shutdown\n"
            )
            result = subprocess.run(
                ["bash", "-c", command],
                env={
                    **os.environ,
                    "FLEET_MACHINE_ID": "1234567890abcd",
                    "OUT_DIR": d,
                    "CODEX_AUTH_SHA256": explicit,
                    "LOCAL_STATUS_PORT": "",
                    "RUN_LOG_TOKEN": "exact-run",
                    "FINISHED": "1",
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            assert (result.returncode == 0) == (not explicit)
            assert (Path(d) / "guest-shutdown.confirmed").exists() == (not explicit)


@pytest.mark.parametrize("signal_mode", ["direct", "durable"])
@pytest.mark.parametrize("boundary", ["spawn", "published"])
def test_explicit_codex_driver_wait_owns_spawn_signal_boundary(tmp_path, handoff, signal_mode, boundary):
    import pwd
    import signal
    from pathlib import Path

    module, owner, _ = handoff
    driver = Path(
        os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_DRIVER", str(rb.REPO_ROOT / "scripts/cloudbench-run.sh"))
    ).read_text()

    def function(name):
        begin = driver.index(name + "() {")
        end = driver.index("\n}\n", begin) + 3
        return driver[begin:end]

    helper = tmp_path / "helper.py"
    actual = Path(
        os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_HELPER", str(rb.REPO_ROOT / "scripts/cloudbench-codex-auth.py"))
    )
    helper.write_text(
        "import runpy\nfrom pathlib import Path\ns=runpy.run_path("
        + repr(str(actual))
        + ')\ns["main"].__globals__["ROOT"]=Path('
        + repr(str(module.ROOT))
        + ')\ns["main"]()\n'
    )
    gate = driver[driver.index("unset CODEX_AUTH_PATH\n") : driver.index("# ── 0. Sanity:")]
    request = tmp_path / "shutdown.request"
    pidfile = tmp_path / "child.pid"
    setup = 'set -euT\nACTIVE_COMMAND_PID=""\nACTIVE_COMMAND_STARTING=0\nACTIVE_COMMAND_SHUTDOWN_PENDING=0\nACTIVE_COMMAND_SIGNALLED=0\nHEARTBEAT_SLEEP_PID=""\nCODEX_AUTH_ADMISSION_TOKEN=""\nSTACK_PID=""\nTAIL_PID=""\nGUEST_DIAGNOSTICS_PID=""\n'
    setup += 'log() { :; }\nfinish() { exit "$1"; }\npublish_cleanup_ack() { :; }\n'
    setup += function("run_with_heartbeat") + function("request_graceful_shutdown") + function("cleanup_stack")
    # Exact instruction after spawn and before PID publication: a direct signal
    # must not be forgotten merely because there is no durable status request.
    inject = 'printf "%s\\n" "$!" > "$CHILD_PID_FILE"; '
    if signal_mode == "durable":
        inject += 'touch "$SHUTDOWN_REQUEST_FILE"; '
    inject += 'kill -TERM "$$"'
    setup += 'kill() { if [ "${1:-}" = -INT ]; then printf "INT\\n" >> "$SIGNALS_FILE"; fi; builtin kill "$@"; }\n'
    setup += "trap cleanup_stack EXIT\ntrap request_graceful_shutdown TERM\n"
    trigger = r"command_pid=\$!" if boundary == "spawn" else "ACTIVE_COMMAND_STARTING=0"
    setup += 'trap \'if [ "$BASH_COMMAND" = "' + trigger + '" ]; then trap - DEBUG; ' + inject + "; fi' DEBUG\n"
    env = {
        **os.environ,
        "CODEX_AUTH_HELPER": str(helper),
        "CLOUDBENCH_RUN_TOKEN": owner["run_token"],
        "CLOUDBENCH_CODEX_AUTH_MACHINE_ID": owner["machine_id"],
        "CLOUDBENCH_CODEX_AUTH_SHA256": owner["sha256"],
        "APP_USER": pwd.getpwuid(os.getuid()).pw_name,
        "SHUTDOWN_REQUEST_FILE": str(request),
        "CHILD_PID_FILE": str(pidfile),
        "SIGNALS_FILE": str(tmp_path / "signals"),
    }
    process = subprocess.Popen(
        ["bash", "-c", setup + gate],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
    except BaseException:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise
    assert process.returncode == 143, (stdout, stderr)
    assert pidfile.exists(), stderr
    assert (tmp_path / "signals").read_text().splitlines() == ["INT"], stderr
    with pytest.raises(ProcessLookupError):
        os.kill(int(pidfile.read_text()), 0)
    assert not module.directory(owner).exists(), stderr


def _cloud_controller_source():
    from pathlib import Path

    return Path(
        os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_CLOUD", str(rb.REPO_ROOT / "scripts/run-bench-cloud"))
    ).read_text()


def _archived_generation_transport(cloud):
    """The controller always defines this ordinary-path transport before its SSH/boot callers."""
    begin = cloud.index("# BEGIN archived-generation transport")
    return cloud[begin : cloud.index("# END archived-generation transport.", begin)]


@pytest.mark.parametrize(
    "probe_timeout,delay,expected,slack",
    [(None, 0, 10, 0), ("8", 5.2, 8, 0), ("999", 0, 270, 1)],
)
def test_explicit_codex_stage_uses_owned_probe_budget(tmp_path, probe_timeout, delay, expected, slack):
    """Exercise the actual timeout owner, including a valid connection beyond five seconds."""
    import re
    import shlex
    import signal
    import sys

    cloud = _cloud_controller_source()
    stage = re.search(r"(?ms)^stage_explicit_codex_auth\(\).*?^}\n", cloud).group()
    timeout = re.search(r"(?ms)^_with_timeout\(\).*?^}\n", cloud).group()
    fake = tmp_path / "flyctl"
    fake.write_text("""#!/usr/bin/env python3
import json,os,shlex,sys,time
args=sys.argv[1:]
assert args[:2] in (['ssh','console'],['ssh','sftp'])
assert args[args.index('--machine')+1]=='abcdef12345678'
with open(os.environ['FLY_CALLS'],'a') as output:
 output.write(json.dumps({'pid':os.getpid(),'transport':args[1]})+'\\n')
if args[1]=='console' and ' stage ' in shlex.split(args[-1])[-1]:
 time.sleep(float(os.environ['CONNECT_DELAY']))
 print('stage-ready')
""")
    fake.chmod(0o755)
    auth = tmp_path / "auth.json"
    auth.write_text('{"synthetic":true}')
    auth.chmod(0o600)
    env = {
        **os.environ,
        "PATH": str(tmp_path) + os.pathsep + os.path.dirname(sys.executable) + os.pathsep + os.environ["PATH"],
        "FLY_CALLS": str(tmp_path / "calls.jsonl"),
        "CONNECT_DELAY": str(delay),
    }
    env.pop("CLOUDBENCH_SSH_PROBE_TIMEOUT_SECONDS", None)
    if probe_timeout is not None:
        env["CLOUDBENCH_SSH_PROBE_TIMEOUT_SECONDS"] = probe_timeout
    # Stop this fixture after its first real failed connection, rather than
    # spending the production retry ceiling repeating the same deterministic fault.
    script = "set -eu\n" + _archived_generation_transport(cloud)
    script += timeout.replace("_with_timeout()", "_actual_with_timeout()", 1) + stage
    script += f"""
_with_timeout() {{
  printf '%s\\n' "$1" >> {shlex.quote(str(tmp_path / "budgets"))}
  local status=0
  _actual_with_timeout "$@" || status=$?
  [ "$status" = 0 ] || exit "$status"
}}
APP=owned-fixture-app
mid=abcdef12345678
RUN_LOG_TOKEN=owned-fixture-run
OUT_DIR={shlex.quote(str(tmp_path))}
CODEX_AUTH_SOURCE={shlex.quote(str(auth))}
CODEX_AUTH_SHA256={"a" * 64}
stage_explicit_codex_auth /cloudbench-codex-auth.py
"""
    process = subprocess.Popen(
        ["bash", "-c", script],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
    assert process.returncode == 0, (process.returncode, stdout, stderr)
    budgets = [int(value) for value in (tmp_path / "budgets").read_text().splitlines()]
    # Bash SECONDS advances on wall-clock second boundaries, so a boundary between
    # setting the stage deadline and reading its first remaining budget costs one second.
    assert expected - slack <= budgets[0] <= expected
    assert len(budgets) == 3 and all(0 < value <= 270 for value in budgets)
    calls = [json.loads(line) for line in (tmp_path / "calls.jsonl").read_text().splitlines()]
    assert [call["transport"] for call in calls] == ["console", "sftp", "console"]
    for call in calls:
        with pytest.raises(ProcessLookupError):
            os.kill(call["pid"], 0)


@pytest.mark.parametrize("mode", ["warm", "later-upload-failure"])
def test_explicit_codex_legacy_sftp_retry_clears_code_destination(tmp_path, mode):
    """Real exclusive file creation models Fly SFTP's no-overwrite destination contract."""
    import re
    import shlex
    import sys

    cloud = _cloud_controller_source()
    start = cloud.index('_ok=0\nstage_err="$(mktemp)"')
    stop = cloud.index('\n[ "$_ok" = 1 ] ||', start)
    staging = cloud[start:stop]
    guest = tmp_path / "guest"
    guest.mkdir()
    helper = tmp_path / "helper"
    helper.write_text("cloudbench-run\n")
    if mode == "warm":
        (guest / "cloudbench-codex-auth.py").write_text("old helper\n")
    fake = tmp_path / "fly.py"
    fake.write_text("""import os,pathlib,shlex,sys
root=pathlib.Path(os.environ['GUEST'])
args=sys.argv[1:]
if args[0]=='read':
 command=args[2]
 if command.startswith('rm -f '):
  for name in shlex.split(command)[2:]:
   assert name.startswith(('/data/','/tmp/'))
   (root/pathlib.Path(name).name).unlink(missing_ok=True)
 elif command.startswith('test -x '):
  assert (root/'cloudbench-run.sh').is_file()
  assert 'cloudbench-run' in (root/'wrapper').read_text()
  print('WROTE')
 else:raise AssertionError('unexpected fixture command')
else:
 assert args[:3]==['ssh','sftp','put']
 assert args[args.index('--machine')+1]=='abcdef12345678'
 dest=root/pathlib.Path(args[-1]).name
 if os.environ['MODE']=='later-upload-failure' and dest.name=='cloudbench-fetch-ref.sh' and not (root/'fault-fired').exists():
  (root/'fault-fired').write_text('once')
  raise SystemExit(23)
 with dest.open('xb') as output:output.write(pathlib.Path(args[-2]).read_bytes())
 dest.chmod(0o755)
""")
    env = {**os.environ, "GUEST": str(guest), "MODE": mode, "CLOUDBENCH_STAGE_ATTEMPTS": "2", "TMPDIR": str(tmp_path)}
    script = "set -eu\nSTAGED_LOCAL_FILES=()\nAPP=owned-fixture-app\nmid=abcdef12345678\n"
    for variable in sorted(set(re.findall(r"\$(CLOUDBENCH_GUEST_[A-Z_]+)", staging))):
        script += variable + "=" + shlex.quote(str(helper)) + "\n"
    script += f"""
REMOTE_TMP_SCRIPT=/tmp/wrapper
WRAPPER_LOCAL={shlex.quote(str(helper))}
LOCAL_PATCH_FILE=''
CLOUDBENCH_REQUIRE_EXECUTION_PROVENANCE=0
FLY() {{ {shlex.quote(sys.executable)} {shlex.quote(str(fake))} "$@"; }}
ssh_read() {{ {shlex.quote(sys.executable)} {shlex.quote(str(fake))} read "$@"; }}
sleep() {{ :; }}
trap 'rm -f "${{stage_err:-}}"' EXIT
{staging}
cp "$stage_err" {shlex.quote(str(tmp_path / "stage-errors.private.log"))}
[ "$_ok" = 1 ]
"""
    result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr + (tmp_path / "stage-errors.private.log").read_text()
    assert (guest / "cloudbench-codex-auth.py").read_bytes() == helper.read_bytes()
    assert (guest / "wrapper").read_bytes() == helper.read_bytes()
    assert (guest / "fault-fired").exists() == (mode == "later-upload-failure")


@pytest.mark.parametrize(
    "label,expected,reaped_before_recheck,child_rc",
    [
        ("credential-handoff", 143, False, 0),
        ("benchmark", 0, False, 0),
        ("credential-handoff", 143, True, 7),
        ("benchmark", 7, True, 7),
    ],
)
def test_explicit_codex_pending_shutdown_survives_successful_child(
    tmp_path, label, expected, reaped_before_recheck, child_rc
):
    """A TERM in the start window cancels the child once; the pending recheck must not exit.

    reaped_before_recheck holds the driver until the cancelled child has exited
    and been reaped, which a loaded host can do between the signal and the
    recheck (the agents coverage flake of 2026-10-18 exited 143 there). Its child
    exits non-zero so the benchmark label must return that collected status."""
    import shlex
    import signal
    from pathlib import Path

    driver = Path(
        os.environ.get("CLOUDBENCH_CODEX_AUTH_TEST_DRIVER", str(rb.REPO_ROOT / "scripts/cloudbench-run.sh"))
    ).read_text()

    def function(name):
        begin = driver.index(name + "() {")
        end = driver.index("\n}\n", begin) + 3
        return driver[begin:end]

    heartbeat = function("run_with_heartbeat")
    if reaped_before_recheck:
        recheck = '    ACTIVE_COMMAND_STARTING=0\n    if [ -e "$SHUTDOWN_REQUEST_FILE" ]'
        assert heartbeat.count(recheck) == 1
        heartbeat = heartbeat.replace(
            recheck,
            '    ACTIVE_COMMAND_STARTING=0\n'
            '    while kill -0 "$ACTIVE_COMMAND_PID" 2>/dev/null; do sleep 0.01; done\n'
            '    if [ -e "$SHUTDOWN_REQUEST_FILE" ]',
        )
    child = tmp_path / "child.py"
    ready = tmp_path / "ready"
    pidfile = tmp_path / "pid"
    nextstep = tmp_path / "next"
    child.write_text(
        "import os,signal,sys,time\nfrom pathlib import Path\nsignal.signal(signal.SIGINT,lambda *_:sys.exit(%d))\nPath(sys.argv[1]).write_text(str(os.getpid()))\nwhile True:time.sleep(0.01)\n" % child_rc
    )
    command = 'set -euT\nACTIVE_COMMAND_PID=""\nACTIVE_COMMAND_STARTING=0\nACTIVE_COMMAND_SHUTDOWN_PENDING=0\nACTIVE_COMMAND_SIGNALLED=0\nHEARTBEAT_SLEEP_PID=""\nlog() { :; }\n'
    command += heartbeat + function("request_graceful_shutdown")
    command += "trap request_graceful_shutdown TERM\n"
    command += 'trap \'if [ "$BASH_COMMAND" = "ACTIVE_COMMAND_STARTING=0" ]; then trap - DEBUG; printf "%s\\n" "$ACTIVE_COMMAND_PID" > "$PID_FILE"; while [ ! -f "$READY" ]; do sleep 0.01; done; kill -TERM "$$"; fi\' DEBUG\n'
    command += (
        "run_with_heartbeat "
        + shlex.quote(label)
        + " "
        + shlex.quote(rb.sys.executable)
        + " "
        + shlex.quote(str(child))
        + " "
        + shlex.quote(str(ready))
        + "\ntouch "
        + shlex.quote(str(nextstep))
        + "\n"
    )
    process = subprocess.Popen(
        ["bash", "-c", command],
        env={
            **os.environ,
            "PID_FILE": str(pidfile),
            "READY": str(ready),
            "SHUTDOWN_REQUEST_FILE": str(tmp_path / "request"),
            "CLOUDBENCH_HEARTBEAT_SECONDS": "0.01",
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=FIXTURE_HOST_GUARD_SECONDS)
    except BaseException:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise
    assert process.returncode == expected, (stdout, stderr)
    assert nextstep.exists() == (expected == 0)
    with pytest.raises(ProcessLookupError):
        os.kill(int(pidfile.read_text()), 0)
