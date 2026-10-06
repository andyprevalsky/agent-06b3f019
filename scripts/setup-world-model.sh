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
    signature="$(shasum -a 256 "$manifest" | cut -d ' ' -f 1)"
    if [ ! -f "$native_env/requirements.sha256" ] || [ "$(cat "$native_env/requirements.sha256")" != "$signature" ]; then
        uv pip install --python "$native_python" -r "$manifest" >&2
        uv pip check --python "$native_python" >&2
        printf '%s\n' "$signature" > "$native_env/requirements.sha256"
    fi
fi
"$native_python" - <<'PY'
import importlib.metadata,json,sys
assert sys.version_info >= (3,12), 'Native world model requires Python >=3.12'
dist=importlib.metadata.distribution('experiential')
assert dist.version=='0.7.158', 'Unexpected experiential version'
origin=json.loads(dist.read_text('direct_url.json'))
assert origin['vcs_info']['commit_id']=='bf75987eac5e8c984d8f3868249f84e4095d1733', 'Unexpected upstream commit'
PY
printf '%s\n' "$native_python"
