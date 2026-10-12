#!/usr/bin/env bash
# Native simulator dependencies live outside the Python 3.11 browser/worker venv.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
native_env="$repo_root/.context/experiential-venv"
manifest="$repo_root/agents/requirements-world-model.txt"
if [ -n "${WMH_NATIVE_PYTHON:-}" ]; then
    native_python="$WMH_NATIVE_PYTHON"
else
    native_python="$native_env/bin/python"
    if [ ! -x "$native_python" ]; then
        uv venv --python 3.12 "$native_env" >&2
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        signature="$(sha256sum "$manifest" | cut -d ' ' -f 1)"
    elif command -v shasum >/dev/null 2>&1; then
        signature="$(shasum -a 256 "$manifest" | cut -d ' ' -f 1)"
    else
        echo "Native simulator setup requires sha256sum or shasum" >&2
        exit 1
    fi
    if [ ! -f "$native_env/requirements.sha256" ] || [ "$(cat "$native_env/requirements.sha256")" != "$signature" ]; then
        uv pip install --python "$native_python" -r "$manifest" >&2
        uv pip check --python "$native_python" >&2
        printf '%s\n' "$signature" > "$native_env/requirements.sha256"
    fi
fi
"$native_python" - <<'PY'
import importlib.metadata,sys
assert sys.version_info >= (3,12), 'Native world model requires Python >=3.12'
dist=importlib.metadata.distribution('experiential')
# The vendored wheel's local label pins upstream commit bf75987e (see agents/vendor/world-model/SOURCES.txt).
assert dist.version=='0.7.158+rose.bf75987e', 'Unexpected experiential version'
PY
printf '%s\n' "$native_python"
