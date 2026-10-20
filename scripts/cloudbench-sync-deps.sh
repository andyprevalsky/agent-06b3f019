#!/usr/bin/env bash
# Keep a cloudbench volume checkout's dependency trees in lockstep with the
# dependency-donor image. Branch code is git-synced on every run, while deps are
# baked into /app; a manifest mismatch therefore means the warm image must be
# rebuilt rather than letting services fail later with MODULE_NOT_FOUND.
set -euo pipefail

VERIFY_OVERLAY_CACHE=0
if [ "${1:-}" = --verify-overlay-cache ]; then VERIFY_OVERLAY_CACHE=1; shift; fi

DEPS_DIR="${1:?usage: cloudbench-sync-deps.sh <donor-dir> <repo-dir>}"
REPO_DIR="${2:?usage: cloudbench-sync-deps.sh <donor-dir> <repo-dir>}"
DEPS_DIR="$(cd "$DEPS_DIR" && pwd -P)"
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
REBUILD_DEPS="${CLOUDBENCH_REBUILD_DEPS:-0}"
CONTROL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[ -d "$CONTROL_DIR/lib" ] && CONTROL_LIB_DIR="$CONTROL_DIR/lib" || CONTROL_LIB_DIR="$CONTROL_DIR"
ENV_HELPER="${CLOUDBENCH_ENV_HELPER:-$CONTROL_LIB_DIR/cloudbench-env.sh}"
[ -f "$ENV_HELPER" ] || { echo "[cloudbench] FATAL: env helper missing: $ENV_HELPER" >&2; exit 1; }
# shellcheck source=scripts/lib/cloudbench-env.sh
source "$ENV_HELPER"

# Matching image trees -> private writable overlay -> checkout-relative runtime.
# Without Linux metadata copy-up support, retain the existing rsync path. The
# driver chowns these trees recursively; ordinary overlay would copy every byte.
OVERLAY_TREES=()
MATERIALIZING_OVERLAY_TREE=""
MATERIALIZING_OVERLAY_FRESH=""
overlay_state_dir() {
    local relative="${1#"$REPO_DIR"/}"
    printf '%s/.cloudbench-deps-overlays/%s\n' "$REPO_DIR" "${relative//\//-}"
}

owned_overlay() {
    local tree="$1" state options
    state="$(overlay_state_dir "$tree")"
    [ -f "$state/owner" ] && [ ! -L "$state/owner" ] || return 1
    [ "$(tail -n 1 "$state/owner")" = "$tree" ] || return 1
    options="$(findmnt -n -o FSTYPE,OPTIONS --mountpoint "$tree" 2>/dev/null)" || return 1
    case "$options" in
        "overlay "*"upperdir=$state/upper,"*|"overlay "*"upperdir=$state/upper") return 0 ;;
    esac
    return 1
}

detach_owned_overlay() {
    local tree="$1" state
    owned_overlay "$tree" || return 0
    state="$(overlay_state_dir "$tree")"
    umount -- "$tree" || { echo "[cloudbench] FATAL: could not release owned dependency overlay: $tree" >&2; return 1; }
    rm -rf "$state"
}

restore_owned_overlay() {
    local tree="$1" state lower
    state="$(overlay_state_dir "$tree")"
    [ -f "$state/owner" ] && [ ! -L "$state/owner" ] || return 1
    [ "$(tail -n 1 "$state/owner")" = "$tree" ] || return 1
    lower="$(head -n 1 "$state/owner")"
    mkdir -p "$tree"
    mount -t overlay overlay -o "lowerdir=$lower,upperdir=$state/upper,workdir=$state/work,metacopy=on" "$tree"
}

materialize_owned_overlay() {
    local tree="$1" fresh state
    owned_overlay "$tree" || return 0
    state="$(overlay_state_dir "$tree")"
    # Central installs and unreadable-cache repairs retain the original copied
    # tree's rollback semantics. Pay for a copy only on these exceptional paths.
    fresh="$(mktemp -d "$tree.cloudbench-materialize.XXXXXX")"
    MATERIALIZING_OVERLAY_FRESH="$fresh"
    if ! rsync -a --delete "$tree/" "$fresh/"; then
        rm -rf "$fresh"
        MATERIALIZING_OVERLAY_FRESH=""
        return 1
    fi
    MATERIALIZING_OVERLAY_TREE="$tree"
    if ! umount -- "$tree"; then
        MATERIALIZING_OVERLAY_TREE=""
        rm -rf "$fresh"
        MATERIALIZING_OVERLAY_FRESH=""
        return 1
    fi
    if rmdir "$tree" && mv "$fresh" "$tree"; then
        MATERIALIZING_OVERLAY_TREE=""
        MATERIALIZING_OVERLAY_FRESH=""
        rm -rf "$state"
        return 0
    fi
    restore_owned_overlay "$tree" || return 1
    MATERIALIZING_OVERLAY_TREE=""
    rm -rf "$fresh"
    MATERIALIZING_OVERLAY_FRESH=""
    return 1
}

cleanup_failed_overlays() {
    local status=$? tree
    [ "$status" = "0" ] && return 0
    if [ -n "$MATERIALIZING_OVERLAY_TREE" ] \
        && [ ! -f "$MATERIALIZING_OVERLAY_TREE/.cloudbench-deps-fingerprint" ] \
        && ! owned_overlay "$MATERIALIZING_OVERLAY_TREE"; then
        restore_owned_overlay "$MATERIALIZING_OVERLAY_TREE" || status=1
    fi
    [ -z "$MATERIALIZING_OVERLAY_FRESH" ] || rm -rf "$MATERIALIZING_OVERLAY_FRESH"
    for tree in "${OVERLAY_TREES[@]-}"; do
        [ -z "$tree" ] || detach_owned_overlay "$tree" || status=1
    done
    return "$status"
}
trap cleanup_failed_overlays EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

mount_fresh_dependency_overlay() {
    local donor_tree="$1" repo_tree="$2" state base command
    [ "${CLOUDBENCH_DEPENDENCY_OVERLAY:-1}" != "0" ] && [ "$REBUILD_DEPS" != "1" ] || return 1
    [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" = "0" ] || return 1
    for command in mount umount findmnt; do command -v "$command" >/dev/null 2>&1 || return 1; done
    # Overlay option delimiters and findmnt escapes must never change a path.
    case "$donor_tree$repo_tree" in *[[:space:]:,\\]*) return 1 ;; esac
    [ ! -L "$donor_tree" ] && [ ! -L "$repo_tree" ] || return 1
    [ -z "$(find "$repo_tree" -mindepth 1 -maxdepth 1 -print -quit)" ] || return 1
    state="$(overlay_state_dir "$repo_tree")"
    base="$REPO_DIR/.cloudbench-deps-overlays"
    [ ! -L "$base" ] && [ ! -L "$state" ] || return 1
    if [ -e "$state" ]; then
        # A stopped guest loses its mounts. Discard only this exact target's
        # private backing files: metacopy inodes cannot be reused on a new image.
        [ -f "$state/owner" ] && [ ! -L "$state/owner" ] || return 1
        [ "$(head -n 1 "$state/owner")" = "$donor_tree" ] \
            && [ "$(tail -n 1 "$state/owner")" = "$repo_tree" ] || return 1
        findmnt -n --mountpoint "$repo_tree" >/dev/null 2>&1 && return 1
        rm -rf "$state"
    fi
    (umask 077; mkdir -p "$state/upper" "$state/work") || return 1
    chmod 700 "$base"
    # Overlay exposes the upper root's metadata, including before the driver
    # changes ownership. Preserve the donor's runtime-user access on every tree.
    if ! chown --reference="$donor_tree" "$state/upper" \
        || ! chmod --reference="$donor_tree" "$state/upper"; then
        rm -rf "$state"
        return 1
    fi
    printf '%s\n' "$donor_tree" "$repo_tree" > "$state/owner"
    chmod 600 "$state/owner"
    # Record before mount so TERM during its syscall can retire the same target.
    OVERLAY_TREES+=("$repo_tree")
    if mount -t overlay overlay -o "lowerdir=$donor_tree,upperdir=$state/upper,workdir=$state/work,metacopy=on" "$repo_tree" 2>/dev/null; then
        echo "[cloudbench] reusing baked dependencies through private metadata-copy-up overlay → $repo_tree"
        return 0
    fi
    rm -rf "$state"
    echo "[cloudbench] dependency overlay unavailable; copying baked tree → $repo_tree"
    return 1
}

# Git cleanup runs as the application user, while these private backing files
# are intentionally root-owned. Preserve only a validated producer namespace.
if [ "$VERIFY_OVERLAY_CACHE" = 1 ]; then
    python3 - "$DEPS_DIR" "$REPO_DIR" <<'PYOVERLAY'
import os, stat, subprocess, sys
from pathlib import Path
donor, repo = map(Path, sys.argv[1:])
base = repo / '.cloudbench-deps-overlays'
assert os.geteuid() == 0
assert base.resolve(strict=True) == base
info = base.lstat()
assert stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700
assert not subprocess.check_output(['git', '-c', 'safe.directory='+str(repo), '-C', str(repo), 'ls-files', '-z', '--', '.cloudbench-deps-overlays'])
expected = {name.replace('/', '-'): name for name in ('node_modules', 'back-end/node_modules', 'front-end/node_modules', 'agents/node_modules', 'agents/venv')}
for state in base.iterdir():
    assert state.name in expected and state.resolve(strict=True) == state
    info = state.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700
    assert {p.name for p in state.iterdir()} == {'owner', 'upper', 'work'}
    for name in ('upper', 'work'):
        path = state / name
        assert path.resolve(strict=True) == path and stat.S_ISDIR(path.lstat().st_mode)
    owner = state / 'owner'
    fd = os.open(owner, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        assert stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 4096
        raw = stream.read(4097)
    relative = expected[state.name]
    assert raw == (str(donor / relative)+'\n'+str(repo / relative)+'\n').encode()
PYOVERLAY
    exit $?
fi

if ! command -v rsync >/dev/null 2>&1; then
    echo "[cloudbench] FATAL: rsync is required to refresh baked dependency trees." >&2
    echo "[cloudbench] Install rsync (e.g. apt-get install -y rsync) and retry." >&2
    exit 127
fi

sync_tree() {
    local label="$1" donor_tree="$2" repo_tree="$3" expected="$4"
    local marker="$repo_tree/.cloudbench-deps-fingerprint"
    local installed=""
    SYNC_TREE_REFRESHED=0
    [ -f "$marker" ] && installed="$(cat "$marker" 2>/dev/null || true)"
    if [ ! -d "$repo_tree" ] || [ "$installed" != "$expected" ]; then
        echo "[cloudbench] refreshing baked $label dependencies → $repo_tree"
        mkdir -p "$repo_tree"
        if ! mount_fresh_dependency_overlay "$donor_tree" "$repo_tree"; then
            rsync -a --delete "$donor_tree/" "$repo_tree/"
        fi
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

python_venv_healthy() {
    local tree="$1"
    [ -x "$tree/bin/python" ] \
        && "$tree/bin/python" -c 'import pip, temporalio, traceback' >/dev/null 2>&1
}

refresh_python_dependencies_from_donor() {
    local expected="$1" donor="$2"
    local target="$REPO_DIR/agents/venv"
    local fresh="$REPO_DIR/agents/.venv-cloudbench-refresh.$$"
    local backup="$REPO_DIR/agents/.venv-cloudbench-unhealthy.$$"
    local attempt overlay_backup=0
    echo "[cloudbench] refreshing unreadable Python venv from the immutable donor"
    for attempt in 1 2 3; do
        rm -rf "$fresh"
        if [ -e "$backup" ]; then
            if [ -e "$target" ] || ! mv "$backup" "$target"; then
                echo "[cloudbench] FATAL: could not restore cached Python venv backup" >&2
                return 1
            fi
        fi
        mkdir -p "$fresh"
        if ! rsync -a --delete "$donor/" "$fresh/"; then
            rm -rf "$fresh"
            sleep "$attempt"
            continue
        fi
        # Never read the unhealthy tree to prepare its replacement. Retain its
        # backing state until a complete donor copy relocates and passes health.
        overlay_backup=0
        if owned_overlay "$target"; then
            overlay_backup=1
            MATERIALIZING_OVERLAY_TREE="$target"
            if ! umount -- "$target"; then
                MATERIALIZING_OVERLAY_TREE=""
                rm -rf "$fresh"
                sleep "$attempt"
                continue
            fi
        fi
        if [ -e "$target" ] && ! mv "$target" "$backup"; then
            [ "$overlay_backup" = "0" ] || restore_owned_overlay "$target" || return 1
            MATERIALIZING_OVERLAY_TREE=""
            rm -rf "$fresh"
            sleep "$attempt"
            continue
        fi
        if ! mv "$fresh" "$target"; then
            if [ -e "$backup" ] && ! mv "$backup" "$target"; then
                echo "[cloudbench] FATAL: could not restore cached Python venv backup" >&2
                return 1
            fi
            [ "$overlay_backup" = "0" ] || restore_owned_overlay "$target" || return 1
            MATERIALIZING_OVERLAY_TREE=""
            sleep "$attempt"
            continue
        fi
        if relocate_venv "$donor" "$target" && python_venv_healthy "$target"; then
            rm -rf "$backup"
            printf '%s\n' "$expected" > "$target/.cloudbench-deps-fingerprint"
            MATERIALIZING_OVERLAY_TREE=""
            [ "$overlay_backup" = "0" ] || rm -rf "$(overlay_state_dir "$target")"
            return 0
        fi
        rm -rf "$target"
        if [ -e "$backup" ] && ! mv "$backup" "$target"; then
            echo "[cloudbench] FATAL: could not restore cached Python venv backup" >&2
            return 1
        fi
        [ "$overlay_backup" = "0" ] || restore_owned_overlay "$target" || return 1
        MATERIALIZING_OVERLAY_TREE=""
        sleep "$attempt"
    done
    rm -rf "$fresh"
    if [ -e "$backup" ] && [ ! -e "$target" ]; then
        mv "$backup" "$target" || true
    fi
    echo "[cloudbench] FATAL: cached Python venv is unreadable and donor refresh failed" >&2
    return 1
}

rebuild_node_dependencies() {
    local expected="$1" marker="$REPO_DIR/node_modules/.cloudbench-deps-fingerprint"
    echo "[cloudbench] rebuilding JavaScript dependencies from checked-out manifests"
    local tree
    for tree in "$REPO_DIR/node_modules" "$REPO_DIR/back-end/node_modules" "$REPO_DIR/front-end/node_modules" "$REPO_DIR/agents/node_modules"; do
        materialize_owned_overlay "$tree"
    done
    # Never let an interrupted install retain a marker that claims the tree is
    # current. npm install matches Dockerfile.cloudbench-warm's root-workspace
    # build, and Prisma generation is repeated explicitly for the backend.
    rm -f "$marker"
    (
        cd "$REPO_DIR"
        npm install --no-audit --no-fund
        cd back-end
        npx prisma generate
    )
    printf '%s\n' "$expected" > "$marker"
}

rebuild_python_dependencies() {
    local expected="$1"
    local target="$REPO_DIR/agents/venv"
    local fresh="$REPO_DIR/agents/.venv-cloudbench-new.$$"
    local backup="$REPO_DIR/agents/.venv-cloudbench-old.$$"
    echo "[cloudbench] rebuilding Python dependencies from checked-out requirements"
    materialize_owned_overlay "$target"
    rm -rf "$fresh" "$backup"
    if ! python3 -m venv "$fresh" \
        || ! "$fresh/bin/pip" install --upgrade pip \
        || ! (cd "$REPO_DIR" && "$fresh/bin/pip" install -r agents/requirements.txt); then
        rm -rf "$fresh"
        return 1
    fi
    [ ! -e "$target" ] || mv "$target" "$backup"
    if ! mv "$fresh" "$target"; then
        [ ! -e "$backup" ] || mv "$backup" "$target"
        rm -rf "$fresh"
        return 1
    fi
    # venv launchers embed their creation prefix. Relocate only after the
    # same-filesystem rename; if relocation fails, atomically restore the prior
    # known tree and leave its old fingerprint untouched.
    if ! relocate_venv "$fresh" "$target"; then
        rm -rf "$target"
        [ ! -e "$backup" ] || mv "$backup" "$target"
        return 1
    fi
    rm -rf "$backup"
    printf '%s\n' "$expected" > "$target/.cloudbench-deps-fingerprint"
}

sync_node_workspace_trees() {
    local workspace donor_tree repo_tree
    for workspace in back-end front-end agents; do
        donor_tree="$DEPS_DIR/$workspace/node_modules"
        repo_tree="$REPO_DIR/$workspace/node_modules"
        [ -d "$donor_tree" ] || continue
        sync_tree "JavaScript $workspace" "$donor_tree" "$repo_tree" "$repo_node"
        if [ "$SYNC_TREE_REFRESHED" = "1" ]; then
            # A copied client may belong to the donor's older schema even when
            # dependency manifests match the current checkout.
            rm -f "$REPO_DIR/node_modules/.prisma/.rose-schema-fingerprint"
            printf '%s\n' "$repo_node" > "$repo_tree/.cloudbench-deps-fingerprint"
        fi
    done
}

repo_node="$(cloudbench_node_dependency_fingerprint "$REPO_DIR")"
node_marker="$REPO_DIR/node_modules/.cloudbench-deps-fingerprint"
installed_node=""
[ -f "$node_marker" ] && installed_node="$(cat "$node_marker" 2>/dev/null || true)"
if [ "$installed_node" != "$repo_node" ]; then
    donor_node="$(cloudbench_node_dependency_fingerprint "$DEPS_DIR")"
    if [ "$donor_node" != "$repo_node" ]; then
        if [ "$REBUILD_DEPS" = "1" ]; then
            rebuild_node_dependencies "$repo_node"
        else
            echo "[cloudbench] FATAL: warm image/volume JavaScript dependencies do not match the checked-out ref" >&2
            echo "[cloudbench]        rebuild the image or refresh the warm volume before running benchmarks" >&2
            exit 1
        fi
    else
        sync_tree "JavaScript" "$DEPS_DIR/node_modules" "$REPO_DIR/node_modules" "$repo_node"
        root_node_refreshed="$SYNC_TREE_REFRESHED"
        if [ "$root_node_refreshed" = "1" ]; then
            rm -f "$REPO_DIR/node_modules/.prisma/.rose-schema-fingerprint"
        fi
        sync_node_workspace_trees
        if [ "$root_node_refreshed" = "1" ]; then
            printf '%s\n' "$repo_node" > "$node_marker"
        fi
    fi
fi
# Older volume receipts covered only the root tree. Repair missing workspace
# trees only from an exact matching donor; a valid cached/rebuilt volume remains
# usable when its donor has a different manifest set.
if [ "$installed_node" = "$repo_node" ]; then
    donor_node="$(cloudbench_node_dependency_fingerprint "$DEPS_DIR")"
    if [ "$donor_node" = "$repo_node" ]; then
        sync_node_workspace_trees
    fi
fi

repo_python="$(cloudbench_manifest_fingerprint "$REPO_DIR" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}")"
python_marker="$REPO_DIR/agents/venv/.cloudbench-deps-fingerprint"
installed_python=""
[ -f "$python_marker" ] && installed_python="$(cat "$python_marker" 2>/dev/null || true)"
if [ "$installed_python" != "$repo_python" ]; then
    donor_python="$(cloudbench_manifest_fingerprint "$DEPS_DIR" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}")"
    if [ "$donor_python" != "$repo_python" ]; then
        if [ "$REBUILD_DEPS" = "1" ]; then
            rebuild_python_dependencies "$repo_python"
        else
            echo "[cloudbench] FATAL: warm image/volume Python dependencies do not match the checked-out ref" >&2
            echo "[cloudbench]        rebuild the image or refresh the warm volume before running benchmarks" >&2
            exit 1
        fi
    else
        sync_tree "Python" "$DEPS_DIR/agents/venv" "$REPO_DIR/agents/venv" "$repo_python"
        if [ "$SYNC_TREE_REFRESHED" = "1" ]; then
            relocate_venv "$DEPS_DIR/agents/venv" "$REPO_DIR/agents/venv"
            printf '%s\n' "$repo_python" > "$python_marker"
        fi
    fi
fi
if [ "$installed_python" = "$repo_python" ] \
    && ! python_venv_healthy "$REPO_DIR/agents/venv"; then
    refresh_python_dependencies_from_donor \
        "$repo_python" "$DEPS_DIR/agents/venv"
fi

# npm workspaces hoist runtime packages to the root. These marker directories
# satisfy run.sh's per-service install preflight without mutating the baked tree.
mkdir -p "$REPO_DIR/back-end/node_modules" "$REPO_DIR/agents/node_modules"
touch "$REPO_DIR/back-end/node_modules/.hoisted-to-root"
touch "$REPO_DIR/agents/node_modules/.hoisted-to-root"
