#!/usr/bin/env bash
set -euo pipefail

# npm workspaces commonly hoist every dependency into the repository-level
# node_modules directory. A missing <workspace>/node_modules directory is
# therefore not evidence that the workspace needs an install. Ask npm to
# validate each workspace's declared dependency graph and install only when
# that graph is actually incomplete.

if [ "$#" -eq 0 ]; then
    echo "usage: ensure-workspace-dependencies.sh <workspace> [...]" >&2
    exit 2
fi

for workspace in "$@"; do
    if [ ! -f "$workspace/package.json" ]; then
        echo "dependency preflight: missing $workspace/package.json" >&2
        exit 1
    fi

    if npm pkg get name --workspace="$workspace" --silent >/dev/null 2>&1; then
        if npm ls --workspace="$workspace" --depth=0 --silent >/dev/null 2>&1; then
            continue
        fi
        echo "📦 Installing $workspace dependencies..."
        npm install --workspace="$workspace" --no-audit --no-fund
        npm ls --workspace="$workspace" --depth=0 --silent >/dev/null
    else
        if (cd "$workspace" && npm ls --depth=0 --silent >/dev/null 2>&1); then
            continue
        fi
        echo "📦 Installing $workspace dependencies..."
        (cd "$workspace" && npm install --no-audit --no-fund)
        (cd "$workspace" && npm ls --depth=0 --silent >/dev/null)
    fi
    echo "📦 $workspace deps ready"
done
