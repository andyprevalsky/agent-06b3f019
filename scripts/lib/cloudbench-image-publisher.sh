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

cloudbench_image_publish() {
    local client
    client="${IMAGE_PUBLISHER_CLIENT:-}"
    [ -n "$client" ] || client="$(cloudbench_image_publisher_client)" || return $?
    if [ "${IMAGE_BUILD_BUILDER:-native}" = native ]; then
        # The shared native builder's HTTPS endpoint cannot upgrade embedded
        # BuildKit gRPC. Use its supported classic Docker API without changing
        # the builder configuration or the caller's runtime environment.
        DOCKER_BUILDKIT=0 "$client" "$@" --wg=false
    else
        "$client" "$@" --wg=false
    fi
}
