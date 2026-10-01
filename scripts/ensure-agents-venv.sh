#!/usr/bin/env bash
set -euo pipefail

# An importable temporalio is not evidence that agents/venv matches
# agents/requirements.txt: a merge that bumps a pin (e.g. browser-use 0.11 ->
# 0.13) leaves every existing venv stale while the import probe still passes.
# Reinstall whenever the manifest digest differs from the digest recorded after
# the last successful install.

ROOT="$(cd "${AGENTS_VENV_ROOT:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd)"
VENV="$ROOT/agents/venv"
REQUIREMENTS="$ROOT/agents/requirements.txt"
STAMP="$VENV/.requirements.sha256"

if [ ! -f "$REQUIREMENTS" ]; then
    echo "agents venv preflight: missing $REQUIREMENTS" >&2
    exit 1
fi

requirements_digest() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$REQUIREMENTS" | awk '{print $1}'
    else
        shasum -a 256 "$REQUIREMENTS" | awk '{print $1}'
    fi
}

base_python() {
    if [ -n "${AGENTS_VENV_PYTHON:-}" ]; then
        printf '%s\n' "$AGENTS_VENV_PYTHON"
        return
    fi
    local version candidate
    version="$(cat "$ROOT/agents/.python-version" 2>/dev/null || echo "3.11")"
    if candidate="$(asdf where python "$version" 2>/dev/null)"; then
        candidate="$candidate/bin/python3"
    else
        candidate=""
    fi
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
        printf '%s\n' "$candidate"
    else
        command -v python3
    fi
}

digest="$(requirements_digest)"
if [ -x "$VENV/bin/python" ] \
    && [ "$(cat "$STAMP" 2>/dev/null)" = "$digest" ] \
    && "$VENV/bin/python" -c "import temporalio" 2>/dev/null; then
    echo "✅ agents venv matches requirements.txt"
    exit 0
fi

if [ ! -x "$VENV/bin/python" ]; then
    python_bin="$(base_python)"
    echo "🐍 Creating agents venv with $python_bin ($("$python_bin" --version 2>&1))"
    "$python_bin" -m venv "$VENV"
fi

echo "🐍 Syncing agents venv with requirements.txt..."
rm -f "$STAMP"
"$VENV/bin/python" -m pip install -r "$REQUIREMENTS"
"$VENV/bin/python" -c "import temporalio"
printf '%s\n' "$digest" > "$STAMP"
echo "🐍 Agents venv ready"
