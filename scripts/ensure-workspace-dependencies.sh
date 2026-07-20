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
    [ -f "$workspace/package.json" ] || continue

    if npm ls --workspace="$workspace" --depth=0 --silent >/dev/null 2>&1; then
        continue
    fi

    echo "📦 Installing $workspace dependencies..."
    npm install --workspace="$workspace" --no-audit --no-fund
    npm ls --workspace="$workspace" --depth=0 --silent >/dev/null
    echo "📦 $workspace deps ready"
done
