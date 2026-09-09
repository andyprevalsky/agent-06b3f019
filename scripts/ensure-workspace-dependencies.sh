#!/usr/bin/env bash
set -euo pipefail

# npm workspaces commonly hoist every dependency into the repository-level
# node_modules directory. A missing <workspace>/node_modules directory is
# therefore not evidence that the workspace needs an install. Validate both
# npm's dependency graph and every direct dependency from the workspace so a
# root-only `npm ls --workspace` result cannot hide an incomplete install.

if [ "$#" -eq 0 ]; then
    echo "usage: ensure-workspace-dependencies.sh <workspace> [...]" >&2
    exit 2
fi

workspace_dependencies_resolve() {
    node - "$1/package.json" <<'NODE'
const path = require("path");
const fs = require("fs");
const { createRequire } = require("module");

const manifestPath = path.resolve(process.argv[2]);
const manifest = require(manifestPath);
const requireFromWorkspace = createRequire(manifestPath);
const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
};
const optionalDependencies = new Set(Object.keys(manifest.optionalDependencies || {}));

for (const dependency of Object.keys(dependencies)) {
    if (optionalDependencies.has(dependency)) {
        continue;
    }
    const dependencyPaths = requireFromWorkspace.resolve.paths(dependency) || [];
    const installed = dependencyPaths.some((basePath) =>
        fs.existsSync(path.join(basePath, dependency, "package.json")),
    );
    if (!installed) {
        process.exit(1);
    }
}
NODE
}

# npm ls --depth=0 exits 1 for "invalid" URL/tarball packages that are still
# installed (e.g. xlsx from cdn.sheetjs.com) and for leftover workspace copies.
# Treating that as "need install" retriggers `npm install --workspace=`, which
# prunes a healthy hoisted tree (vite and other bins disappear).
workspace_npm_graph_ready() {
    local workspace="$1"
    local mode="$2"
    local ls_out
    local ls_rc=0
    if [ "$mode" = "workspace" ]; then
        ls_out="$(npm ls --workspace="$workspace" --depth=0 --silent 2>&1)" || ls_rc=$?
    else
        ls_out="$(cd "$workspace" && npm ls --depth=0 --silent 2>&1)" || ls_rc=$?
    fi
    if [ "$ls_rc" -eq 0 ]; then
        return 0
    fi
    if printf '%s\n' "$ls_out" | grep -Eq 'UNMET DEPENDENCY|not installed|missing:'; then
        return 1
    fi
    if printf '%s\n' "$ls_out" | grep -Eq 'invalid:|ELSPROBLEMS|extraneous:'; then
        return 0
    fi
    return 1
}

for workspace in "$@"; do
    if [ ! -f "$workspace/package.json" ]; then
        echo "dependency preflight: missing $workspace/package.json" >&2
        exit 1
    fi

    if npm pkg get name --workspace="$workspace" --silent >/dev/null 2>&1; then
        if workspace_npm_graph_ready "$workspace" workspace \
            && workspace_dependencies_resolve "$workspace"; then
            continue
        fi
        echo "📦 Installing $workspace dependencies..."
        if ! npm install --workspace="$workspace" --no-audit --no-fund; then
            if [ ! -f "$workspace/package-lock.json" ]; then
                echo "dependency preflight: workspace install failed and $workspace has no package-lock.json" >&2
                exit 1
            fi
            echo "📦 Workspace install failed; retrying $workspace from its lockfile..."
            (cd "$workspace" && npm ci --workspaces=false --no-audit --no-fund)
        fi
        workspace_npm_graph_ready "$workspace" workspace
        workspace_dependencies_resolve "$workspace"
    else
        if workspace_npm_graph_ready "$workspace" standalone \
            && workspace_dependencies_resolve "$workspace"; then
            continue
        fi
        echo "📦 Installing $workspace dependencies..."
        (cd "$workspace" && npm install --no-audit --no-fund)
        workspace_npm_graph_ready "$workspace" standalone
        workspace_dependencies_resolve "$workspace"
    fi
    echo "📦 $workspace deps ready"
done
