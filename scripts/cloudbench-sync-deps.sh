#!/usr/bin/env bash
# Keep a cloudbench volume checkout's dependency trees in lockstep with the
# dependency-donor image. Branch code is git-synced on every run, while deps are
# baked into /app; a manifest mismatch therefore means the warm image must be
# rebuilt rather than letting services fail later with MODULE_NOT_FOUND.
set -euo pipefail

DEPS_DIR="${1:?usage: cloudbench-sync-deps.sh <donor-dir> <repo-dir>}"
REPO_DIR="${2:?usage: cloudbench-sync-deps.sh <donor-dir> <repo-dir>}"
# shellcheck source=lib/cloudbench-env.sh
source "$REPO_DIR/scripts/lib/cloudbench-env.sh"

sync_tree() {
    local label="$1" donor_tree="$2" repo_tree="$3" expected="$4"
    local marker="$repo_tree/.cloudbench-deps-fingerprint"
    local installed=""
    SYNC_TREE_REFRESHED=0
    [ -f "$marker" ] && installed="$(cat "$marker" 2>/dev/null || true)"
    if [ ! -d "$repo_tree" ] || [ "$installed" != "$expected" ]; then
        echo "[cloudbench] refreshing baked $label dependencies → $repo_tree"
        mkdir -p "$repo_tree"
        rsync -a --delete "$donor_tree/" "$repo_tree/"
        SYNC_TREE_REFRESHED=1
    fi
}

relocate_venv() {
    local donor_tree="$1" repo_tree="$2"
    python3 - "$donor_tree" "$repo_tree" <<'PY'
import os
import pathlib
import sys

donor = os.fsencode(os.path.abspath(sys.argv[1]))
repo = os.fsencode(os.path.abspath(sys.argv[2]))
root = pathlib.Path(sys.argv[2])
rewritten = 0
for path in root.rglob("*"):
    if path.suffix == ".pyc":
        path.unlink(missing_ok=True)
        continue
    if path.is_symlink():
        target = os.readlink(path)
        target_bytes = os.fsencode(target)
        if donor in target_bytes:
            path.unlink()
            path.symlink_to(os.fsdecode(target_bytes.replace(donor, repo)))
            rewritten += 1
        continue
    if not path.is_file():
        continue
    data = path.read_bytes()
    if donor not in data:
        continue
    if b"\0" in data:
        raise SystemExit(f"binary venv file contains donor prefix and cannot be relocated safely: {path}")
    path.write_bytes(data.replace(donor, repo))
    rewritten += 1
print(f"[cloudbench] relocated {rewritten} Python venv path(s) to {root}")
PY
}

repo_node="$(cloudbench_node_dependency_fingerprint "$REPO_DIR")"
node_marker="$REPO_DIR/node_modules/.cloudbench-deps-fingerprint"
installed_node=""
[ -f "$node_marker" ] && installed_node="$(cat "$node_marker" 2>/dev/null || true)"
if [ "$installed_node" != "$repo_node" ]; then
    donor_node="$(cloudbench_node_dependency_fingerprint "$DEPS_DIR")"
    if [ "$donor_node" != "$repo_node" ]; then
        echo "[cloudbench] FATAL: warm image/volume JavaScript dependencies do not match the checked-out ref" >&2
        echo "[cloudbench]        rebuild the image or refresh the warm volume before running benchmarks" >&2
        exit 1
    fi
    sync_tree "JavaScript" "$DEPS_DIR/node_modules" "$REPO_DIR/node_modules" "$repo_node"
    if [ "$SYNC_TREE_REFRESHED" = "1" ]; then
        printf '%s\n' "$repo_node" > "$node_marker"
    fi
fi

repo_python="$(cloudbench_manifest_fingerprint "$REPO_DIR" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}")"
python_marker="$REPO_DIR/agents/venv/.cloudbench-deps-fingerprint"
installed_python=""
[ -f "$python_marker" ] && installed_python="$(cat "$python_marker" 2>/dev/null || true)"
if [ "$installed_python" != "$repo_python" ]; then
    donor_python="$(cloudbench_manifest_fingerprint "$DEPS_DIR" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}")"
    if [ "$donor_python" != "$repo_python" ]; then
        echo "[cloudbench] FATAL: warm image/volume Python dependencies do not match the checked-out ref" >&2
        echo "[cloudbench]        rebuild the image or refresh the warm volume before running benchmarks" >&2
        exit 1
    fi
    sync_tree "Python" "$DEPS_DIR/agents/venv" "$REPO_DIR/agents/venv" "$repo_python"
    if [ "$SYNC_TREE_REFRESHED" = "1" ]; then
        relocate_venv "$DEPS_DIR/agents/venv" "$REPO_DIR/agents/venv"
        printf '%s\n' "$repo_python" > "$python_marker"
    fi
fi

# npm workspaces hoist runtime packages to the root. These marker directories
# satisfy run.sh's per-service install preflight without mutating the baked tree.
mkdir -p "$REPO_DIR/back-end/node_modules" "$REPO_DIR/agents/node_modules"
touch "$REPO_DIR/back-end/node_modules/.hoisted-to-root"
touch "$REPO_DIR/agents/node_modules/.hoisted-to-root"
