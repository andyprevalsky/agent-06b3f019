#!/usr/bin/env bash
# Image publication uses a private, verified client. Runtime Fly remains unchanged.

cloudbench_image_install_client() {
    python3 - "$@" <<'PY_IMAGE_CLIENT'
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

cache, url, checksum, version = sys.argv[1:]
cache = Path(cache)
client = cache / "flyctl"
receipt = cache / "verified.json"

def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()

def correct_version(path):
    result = subprocess.run([str(path), "version"], capture_output=True, text=True, timeout=30)
    return result.returncode == 0 and re.search(r"\bv" + re.escape(version) + r"(?:\s|$)", result.stdout)

try:
    if client.is_file() and not client.is_symlink() and receipt.is_file():
        metadata = json.loads(receipt.read_text())
        if (
            metadata.get("archive_sha256") == checksum
            and metadata.get("version") == version
            and metadata.get("binary_sha256") == digest(client)
            and correct_version(client)
        ):
            print(client)
            raise SystemExit(0)
except (OSError, ValueError, subprocess.SubprocessError):
    pass

cache.mkdir(parents=True, exist_ok=True)
print(f"Preparing verified image publisher v{version}", file=sys.stderr)
with tempfile.TemporaryDirectory(prefix=".install-", dir=cache) as temporary:
    temporary = Path(temporary)
    archive = temporary / "publisher.tar.gz"
    with urllib.request.urlopen(url, timeout=180) as response, archive.open("wb") as output:
        for block in iter(lambda: response.read(1024 * 1024), b""):
            output.write(block)
    if digest(archive) != checksum:
        raise SystemExit("Image publisher archive checksum mismatch")
    candidate = temporary / "flyctl"
    with tarfile.open(archive, "r:gz") as package:
        members = [member for member in package.getmembers() if Path(member.name).name == "flyctl"]
        if len(members) != 1 or not members[0].isfile() or members[0].size > 512 * 1024 * 1024:
            raise SystemExit("Image publisher archive has no unique executable")
        with package.extractfile(members[0]) as source, candidate.open("wb") as output:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                output.write(block)
    candidate.chmod(0o700)
    if not correct_version(candidate):
        raise SystemExit("Image publisher version mismatch")
    metadata = {"version": version, "archive_sha256": checksum, "binary_sha256": digest(candidate)}
    prepared_receipt = temporary / "verified.json"
    prepared_receipt.write_text(json.dumps(metadata) + "\n")
    prepared_receipt.chmod(0o600)
    os.replace(candidate, client)
    os.replace(prepared_receipt, receipt)
print(client)
PY_IMAGE_CLIENT
}

cloudbench_image_publisher_client() {
    local platform archive checksum version=0.4.112
    platform="$(uname -s)-$(uname -m)"
    case "$platform" in
        Darwin-arm64)
            archive="flyctl_${version}_macOS_arm64.tar.gz"
            checksum=a2f6b921c4252a7397860f046e16663b08fb7425f2a3798ca143c2ec0e4acb39
            ;;
        Darwin-x86_64)
            archive="flyctl_${version}_macOS_x86_64.tar.gz"
            checksum=45f17000f2156eacd8c6ec7262f57a0aa92d64809ccb139797504173fdc4b36e
            ;;
        Linux-aarch64|Linux-arm64)
            archive="flyctl_${version}_Linux_arm64.tar.gz"
            checksum=63eddd6a7f045955ad1ebe6b3adfa696c86c72656ccbc423315d46d0bbf5fdef
            ;;
        Linux-x86_64)
            archive="flyctl_${version}_Linux_x86_64.tar.gz"
            checksum=5859b57e4428282ffe782c306ce696fa84986b7c7a3ee72b61549c3185484710
            ;;
        *) echo "Unsupported image publisher platform: $platform" >&2; return 2 ;;
    esac
    cloudbench_image_install_client \
        "$GIT_COMMON_DIR/cloudbench-image-publisher/$version/$platform" \
        "https://github.com/superfly/flyctl/releases/download/v$version/$archive" \
        "$checksum" "$version"
}

cloudbench_image_verify_handoff() {
    local client="$1" completion="$2" app="$3" label="$4" arguments=()
    [ -z "${CLOUDBENCH_IMAGE_PUBLISHER_LOG:-}" ] || \
        arguments+=(--publisher-log "$CLOUDBENCH_IMAGE_PUBLISHER_LOG")
    python3 "$(dirname "${BASH_SOURCE[0]}")/cloudbench-image-registry.py" \
        --client "$client" --app "$app" --image "registry.fly.io/$app:$label" \
        --out-file "$completion.handoff.json" "${arguments[@]}"
}

# flyctl bounds only Depot builder provisioning (5 minutes); its BuildKit solve
# and status stream have no deadline. When that stream stops delivering, the
# remote builder can keep working (and publishing) while this client prints
# nothing until the remote side closes the connection: 973 seconds in the
# 2026-10-12 trial. Healthy publications never went quiet for longer than the
# 81-second layer export, and every flyctl-internal silent wait is bounded at
# 300 seconds, so a longer silence ends the attempt for the caller's retry.
cloudbench_image_publish_idle_seconds() {
    local value="${CLOUDBENCH_IMAGE_PUBLISH_IDLE_SECONDS:-360}"
    case "$value" in
        '' | *[!0-9]* | 0*)
            echo "CLOUDBENCH_IMAGE_PUBLISH_IDLE_SECONDS must be a positive integer" >&2
            return 2
            ;;
    esac
    printf '%s\n' "$value"
}

cloudbench_image_publish_job_running() {
    local job
    while read -r job; do
        [ "$job" != "$1" ] || return 0
    done < <(jobs -pr)
    return 1
}

# Run the publisher with its complete output in the private log. Return its
# status, or 124 after it produced no output for the bound and its exact
# process tree was terminated. Cancellation of the caller still owns this tree.
cloudbench_image_publish_watched() {
    local log="$1" idle child size observed="" progress_at
    shift
    idle="$(cloudbench_image_publish_idle_seconds)" || return $?
    if ! declare -F cloudbench_terminate_tree_and_wait >/dev/null; then
        source "$(dirname "${BASH_SOURCE[0]}")/cloudbench-env.sh" || return 2
    fi
    cloudbench_image_publish_child "$@" >"$log" 2>&1 &
    child=$!
    progress_at=$SECONDS
    while cloudbench_image_publish_job_running "$child"; do
        size="$(wc -c <"$log")" || size="$observed"
        if [ "$size" != "$observed" ]; then
            observed="$size"
            progress_at=$SECONDS
        elif [ $((SECONDS - progress_at)) -ge "$idle" ]; then
            echo "Image publisher produced no output for ${idle}s; ending this attempt for the normal retry." >&2
            cloudbench_terminate_tree_and_wait 30 "$child" || return 70
            wait "$child" 2>/dev/null || true
            echo "Image publisher produced no output for ${idle}s; ending this attempt for the normal retry." >>"$log"
            return 124
        fi
        command sleep 1
    done
    wait "$child"
}

cloudbench_image_publish() {
    local client status=0 log resolve_log warning="" resolved=0 handoff_failed=0
    client="${IMAGE_PUBLISHER_CLIENT:-}"
    [ -n "$client" ] || client="$(cloudbench_image_publisher_client)" || return $?
    if [ -n "${CLOUDBENCH_IMAGE_COMPLETION_FILE:-}" ]; then
        cloudbench_image_publish_idle_seconds >/dev/null || return $?
        log="$(mktemp "${CLOUDBENCH_IMAGE_COMPLETION_FILE%.json}.XXXXXX")" || return $?
        mv "$log" "$log.private.log" || { rm -f "$log"; return 1; }
        log="$log.private.log"
        chmod 600 "$log"
        echo "Private image publisher log: $log"
        if cloudbench_image_publish_watched "$log" "$client" "$@"; then
            status=0
        else
            status=$?
        fi
        if [ "$status" != 0 ] && [ "${IMAGE_BUILD_BUILDER:-native}" = native ] &&
            cloudbench_image_known_postpush_failure "$log" "$@"; then
            resolve_log="${log%.private.log}.resolve.private.log"
            (umask 077; : >"$resolve_log") || return $?
            echo "Image pushed; verifying its exact owned tag after builder metadata refusal."
            # An explicit --image takes the SDK prebuilt-image path. It does
            # not submit another Docker build, push, or activate a Machine.
            if DOCKER_BUILDKIT=0 "$client" deploy "$CLOUDBENCH_IMAGE_ATTEMPT_CONTEXT" \
                -c "$CLOUDBENCH_IMAGE_ATTEMPT_CONTEXT/fly.cloudbench-warm.toml" \
                --image "registry.fly.io/$CLOUDBENCH_IMAGE_ATTEMPT_APP:$CLOUDBENCH_IMAGE_ATTEMPT_LABEL" \
                --build-only --depot=false --remote-only -a "$CLOUDBENCH_IMAGE_ATTEMPT_APP" \
                --wg=false >"$resolve_log" 2>&1; then
                resolved=1
                warning="Builder refused final image metadata inspection after publication; exact published tag verified by SDK."
            fi
        fi
        if [ "$status" = 0 ] || [ "$resolved" = 1 ]; then
            if ! CLOUDBENCH_IMAGE_PUBLISHER_LOG="$log" cloudbench_image_verify_handoff \
                "$client" "$CLOUDBENCH_IMAGE_COMPLETION_FILE" \
                "$CLOUDBENCH_IMAGE_ATTEMPT_APP" "$CLOUDBENCH_IMAGE_ATTEMPT_LABEL"; then
                handoff_failed=1
            fi
        fi
        python3 - "$CLOUDBENCH_IMAGE_COMPLETION_FILE" "$status" "$resolved" "$warning" "$handoff_failed" \
            "$CLOUDBENCH_IMAGE_ATTEMPT_APP" "$CLOUDBENCH_IMAGE_ATTEMPT_LABEL" <<'PY_COMPLETION' || return $?
import json,os,re,sys
from pathlib import Path
path,status,resolved,warning,failed,app,label=sys.argv[1:]
handoff_path=Path(path+".handoff.json")
try:
    handoff=json.loads(handoff_path.read_text()) if handoff_path.is_file() else {}
    if not isinstance(handoff,dict):
        handoff={}
except (OSError,ValueError):
    handoff={}
digest=handoff.get("published_digest")
verified=(handoff.get("registry_handoff_verified") is True
          and isinstance(digest,str) and re.fullmatch(r"sha256:[0-9a-f]{64}",digest)
          and handoff.get("published_image_ref")==f"registry.fly.io/{app}:{label}@{digest}")
receipt={**handoff,"publication_verified":bool((status=="0" or resolved=="1") and failed=="0" and verified),
         "publisher_exit_code":int(status),
         "published_tag_resolution_verified":resolved=="1",
         "publication_metadata_warning":warning or None}
with open(path,"w") as output:
    json.dump(receipt,output)
    output.write("\n")
os.chmod(path,0o600)
if (status=="0" or resolved=="1") and not receipt["publication_verified"]:
    print("Published output has no verified registry handoff; original build retained without rebuilding.", file=sys.stderr)
    raise SystemExit(74)
PY_COMPLETION
        if [ "$status" = 0 ] || [ "$resolved" = 1 ]; then
            [ -z "$warning" ] || echo "Warning: $warning"
            return 0
        fi
        echo "Image publisher failed (exit $status); private log retained at $log." >&2
        return "$status"
    fi
    cloudbench_image_publish_child "$client" "$@"
}

cloudbench_image_publish_child() {
    local client="$1"
    shift
    if [ "${IMAGE_BUILD_BUILDER:-native}" = native ]; then
        # The shared native builder's HTTPS endpoint cannot upgrade embedded
        # BuildKit gRPC. Use its supported classic Docker API without changing
        # the builder configuration or the caller's runtime environment.
        # Docker's nonterminal renderer drops transfer progress. Only stderr
        # needs a terminal; closed stdin and inherited stdout keep SDK prompts off.
        DOCKER_BUILDKIT=0 python3 - "$client" "$@" --wg=false <<'PY_NATIVE_PROGRESS'
import errno
import os
import pty
import signal
import subprocess
import sys

master, slave = pty.openpty()
try:
    child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stderr=slave)
finally:
    os.close(slave)

def forward_signal(signum, _frame):
    if child.poll() is None:
        child.send_signal(signum)

for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, forward_signal)
try:
    while True:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break  # A closed PTY slave reports EIO on Linux.
            raise
        if not data:
            break
        sys.stderr.buffer.write(data)
        sys.stderr.buffer.flush()
finally:
    os.close(master)
    status = child.wait()
raise SystemExit(status if status >= 0 else 128 - status)
PY_NATIVE_PROGRESS
    else
        "$client" "$@" --wg=false
    fi
}

cloudbench_image_known_postpush_failure() {
    python3 - "$1" "${CLOUDBENCH_IMAGE_ATTEMPT_CONTEXT:-}" \
        "${CLOUDBENCH_IMAGE_ATTEMPT_APP:-}" "${CLOUDBENCH_IMAGE_ATTEMPT_LABEL:-}" \
        "${CLOUDBENCH_IMAGE_ATTEMPT_PID:-}" "${@:2}" <<'PY_POSTPUSH'
import re,sys
from pathlib import Path

log,context,app,label,pid,*arguments=sys.argv[1:]
def option(name):
    return arguments[arguments.index(name)+1] if name in arguments else None
try:
    context=Path(context).resolve(strict=True)
    owned=(arguments[:2]==["deploy",str(context)] and Path.cwd()==context
           and option("-c")==str(context/"fly.cloudbench-warm.toml")
           and option("--dockerfile")==str(context/"Dockerfile.cloudbench-warm")
           and option("-a")==app and option("--image-label")==label
           and re.fullmatch(r"cloudbench-warm-\d{8}-\d{6}-"+re.escape(pid),label)
           and all(flag in arguments for flag in ("--push","--build-only","--remote-only","--depot=false")))
    text=re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]","",Path(log).read_text(errors="replace"))
    marker=text.rfind("Pushing image done")
    suffix="count not find built image: Error response from daemon: You are not authorized to use this builder"
    final=text[marker:].strip() if marker>=0 else ""
    known=final.endswith(suffix) and "Error: failed to fetch an image or build from source:" in final
except (OSError,ValueError,IndexError):
    owned=known=False
raise SystemExit(0 if owned and known else 1)
PY_POSTPUSH
}
