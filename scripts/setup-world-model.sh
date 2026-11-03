#!/usr/bin/env bash
# Native simulator dependencies live outside the Python 3.11 browser/worker venv.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
native_env="$repo_root/.context/experiential-venv"
manifest="$repo_root/agents/requirements-world-model.txt"
sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d ' ' -f 1
    else
        echo "Native simulator setup requires sha256sum or shasum" >&2
        return 1
    fi
}
# Authenticate the pinned vendor bytes before any native environment mutation.
wheel_name="experiential-0.7.158+rose.bf75987e.elapsed1-py3-none-any.whl"
vendor="$repo_root/agents/vendor/world-model"
expected_digest=""
wheel_records=0
while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "$wheel_name" ]; then
        wheel_records=$((wheel_records + 1))
        digest_line=""
        IFS= read -r digest_line || [ -n "$digest_line" ]
        read -r label expected_digest extra <<< "$digest_line"
        [ "$label" = "sha256:" ] && [ -z "$extra" ] || {
            echo "Invalid native wheel digest in SOURCES.txt" >&2
            exit 1
        }
    fi
done < "$vendor/SOURCES.txt"
[ "$wheel_records" -eq 1 ] || { echo "Missing or duplicate native wheel record in SOURCES.txt" >&2; exit 1; }
case "$expected_digest" in
    *[!0-9a-f]*|'') echo "Invalid native wheel digest in SOURCES.txt" >&2; exit 1 ;;
esac
[ "${#expected_digest}" -eq 64 ] || { echo "Invalid native wheel digest in SOURCES.txt" >&2; exit 1; }
[ "$(sha256_file "$vendor/$wheel_name")" = "$expected_digest" ] || {
    echo "Native wheel SHA-256 differs from SOURCES.txt" >&2
    exit 1
}
# Non-interactive shells often lack the user's uv install dir on PATH.
uv() {
    local candidate
    for candidate in "$(type -P uv || true)" "$repo_root/agents/venv/bin/uv" "${HOME:+$HOME/.local/bin/uv}" "${HOME:+$HOME/.cargo/bin/uv}"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            "$candidate" "$@"
            return
        fi
    done
    echo "Native simulator setup requires uv: run 'agents/venv/bin/python -m pip install uv' (scripts/cloud-build.sh does this)" >&2
    return 127
}
write_signature=false
if [ -n "${WMH_NATIVE_PYTHON:-}" ]; then
    native_python="$WMH_NATIVE_PYTHON"
else
    native_python="$native_env/bin/python"
    if [ ! -x "$native_python" ]; then
        uv venv --python 3.12 "$native_env" >&2
    fi
    signature="$(sha256_file "$manifest")"
    if [ ! -f "$native_env/requirements.sha256" ] || [ "$(cat "$native_env/requirements.sha256")" != "$signature" ]; then
        (cd "$repo_root/agents" && uv pip install --python "$native_python" -r "$manifest") >&2
        uv pip check --python "$native_python" >&2
        write_signature=true
    fi
fi
"$native_python" - <<'PY'
import importlib.metadata,sys
assert sys.version_info >= (3,12), 'Native world model requires Python >=3.12'
dist=importlib.metadata.distribution('experiential')
# The vendored wheel's local label pins upstream commit bf75987e plus the reviewed patches (see agents/vendor/world-model/SOURCES.txt).
assert dist.version=='0.7.158+rose.bf75987e.elapsed1', 'Unexpected experiential version'
import fastapi, uvicorn
PY
if [ "$write_signature" = true ]; then
    printf '%s\n' "$signature" > "$native_env/requirements.sha256"
fi
printf '%s\n' "$native_python"
