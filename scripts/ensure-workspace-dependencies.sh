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

for workspace in "$@"; do
    if [ ! -f "$workspace/package.json" ]; then
        echo "dependency preflight: missing $workspace/package.json" >&2
        exit 1
    fi

    if npm pkg get name --workspace="$workspace" --silent >/dev/null 2>&1; then
        if npm ls --workspace="$workspace" --depth=0 --silent >/dev/null 2>&1 \
            && workspace_dependencies_resolve "$workspace"; then
            continue
        fi
        echo "📦 Installing $workspace dependencies..."
        npm install --workspace="$workspace" --no-audit --no-fund
        npm ls --workspace="$workspace" --depth=0 --silent >/dev/null
        workspace_dependencies_resolve "$workspace"
    else
        if (cd "$workspace" && npm ls --depth=0 --silent >/dev/null 2>&1) \
            && workspace_dependencies_resolve "$workspace"; then
            continue
        fi
        echo "📦 Installing $workspace dependencies..."
        (cd "$workspace" && npm install --no-audit --no-fund)
        (cd "$workspace" && npm ls --depth=0 --silent >/dev/null)
        workspace_dependencies_resolve "$workspace"
    fi
    echo "📦 $workspace deps ready"
done
