#!/usr/bin/env bash
# Fetch and verify the exact ref a cloud benchmark was asked to execute. Never
# fall back to a prior FETCH_HEAD: stale code is worse than a loud infra failure.
set -euo pipefail

REPO_DIR="${1:?usage: cloudbench-fetch-ref.sh <repo-dir> <ref>}"
REF="${2:?usage: cloudbench-fetch-ref.sh <repo-dir> <ref>}"
APP_USER="${CLOUDBENCH_APP_USER:-}"
auth_config=""
tracked_paths=""
fetch_lock_kind=""
fetch_lock_fd=""
fetch_lock_path="$REPO_DIR/.git/cloudbench-fetch.lock"

# An autoscaled worker executes runtime source only. The primary's benchmark
# runner owns the append-only history ledgers, which the workspace patch also
# excludes; a fresh worker volume does not inflate or write them.
source_scope="${CLOUDBENCH_SOURCE_SCOPE:-complete}"
case "$source_scope" in complete|worker-runtime) ;; *)
    echo "[cloudbench] FATAL: unknown CLOUDBENCH_SOURCE_SCOPE '$source_scope'" >&2
    exit 1 ;;
esac
worker_runtime_omitted='agents/benchmarks/history/*.jsonl'

# Retained physical Volumes may bootstrap only inside the authenticated, private
# fresh-generation mount. This is not a fresh-physical-volume declaration.
fresh_checkout_admitted="${CLOUDBENCH_FRESH_VOLUME:-0}"
if [ "${CLOUDBENCH_STORAGE_MODE:-}" = retained-volume-fresh-generation ]; then
    python3 "$(dirname "${BASH_SOURCE[0]}")/cloudbench-isolated-generation.py" \
        --data-root "${CLOUDBENCH_DATA_DIR:-/data}" --verify-checkout "$REPO_DIR" "$REF" || exit 1
    fresh_checkout_admitted=1
fi

# The explicit cold-primary policy is consumed by the driver's FIRST fetch.
# Its later normal git-sync deliberately does not repeat this empty check.
case "${CLOUDBENCH_REQUIRE_EMPTY_CHECKOUT:-0}" in 0|1) ;; *) exit 1 ;; esac
if [ "${CLOUDBENCH_REQUIRE_EMPTY_CHECKOUT:-0}" = 1 ]; then
    if [ "$fresh_checkout_admitted" != 1 ] \
        || ! [[ "$REF" =~ ^[0-9a-f]{40}$ ]] \
        || [ -L "$REPO_DIR" ] \
        || ! python3 -c 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); sys.exit(p.resolve() != p.absolute())' "$REPO_DIR" \
        || { [ -e "$REPO_DIR" ] && { [ ! -d "$REPO_DIR" ] \
             || [ -n "$(find "$REPO_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; }; }; then
        echo "[cloudbench] FATAL: cold-primary first checkout requires an exact ref and absent or empty unlinked destination" >&2
        exit 1
    fi
fi

# Empty Fly volumes carry no Git metadata. Only an explicit REAL-primary
# handoff may initialize a blank checkout; retained non-Git data stays intact.
if [ ! -d "$REPO_DIR/.git" ]; then
    [ "$fresh_checkout_admitted" = 1 ] || {
        echo "[cloudbench] FATAL: checkout missing and fresh-volume bootstrap was not requested" >&2
        exit 1
    }
    [ ! -L "$REPO_DIR" ] && { [ ! -e "$REPO_DIR" ] || {
        [ -d "$REPO_DIR" ] && [ -z "$(find "$REPO_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ];
    }; } || {
        echo "[cloudbench] FATAL: fresh-volume checkout must be absent or empty" >&2
        exit 1
    }
    git init -q "$REPO_DIR"
    git -C "$REPO_DIR" remote add origin https://github.com/Rose-Ai-Labs/rose.git
    if [ -n "$APP_USER" ]; then
        chown "$APP_USER" "$REPO_DIR"
        chown -R "$APP_USER" "$REPO_DIR/.git"
    fi
fi

cleanup() {
    [ -n "$auth_config" ] && rm -f "$auth_config" 2>/dev/null || true
    [ -n "$tracked_paths" ] && rm -f "$tracked_paths" 2>/dev/null || true
    if [ "$fetch_lock_kind" = "flock" ] && [ -n "$fetch_lock_fd" ]; then
        flock -u "$fetch_lock_fd" 2>/dev/null || true
        exec 9>&-
    elif [ "$fetch_lock_kind" = "shlock" ] && [ "$(cat "$fetch_lock_path" 2>/dev/null || true)" = "$$" ]; then
        rm -f "$fetch_lock_path"
    fi
}
trap cleanup EXIT

acquire_fetch_lock() {
    if command -v flock >/dev/null 2>&1; then
        exec 9<> "$fetch_lock_path"
        fetch_lock_fd=9
        if ! flock -n "$fetch_lock_fd"; then
            echo "[cloudbench] FATAL: another Git maintenance or fetch still owns $fetch_lock_path" >&2
            return 1
        fi
        printf '%s\n' "$$" > "$fetch_lock_path"
        fetch_lock_kind="flock"
    elif command -v shlock >/dev/null 2>&1; then
        if ! shlock -p "$$" -f "$fetch_lock_path"; then
            echo "[cloudbench] FATAL: another Git maintenance or fetch still owns $fetch_lock_path" >&2
            return 1
        fi
        fetch_lock_kind="shlock"
    else
        echo "[cloudbench] FATAL: flock or shlock is required for serialized Git maintenance" >&2
        return 1
    fi
}

git_cmd() {
    if [ -n "$auth_config" ]; then
        if [ -n "$APP_USER" ]; then
            gosu "$APP_USER" env "GIT_CONFIG_GLOBAL=$auth_config" GIT_CONFIG_NOSYSTEM=1 \
                git -C "$REPO_DIR" "$@"
        else
            env "GIT_CONFIG_GLOBAL=$auth_config" GIT_CONFIG_NOSYSTEM=1 \
                git -C "$REPO_DIR" "$@"
        fi
    elif [ -n "$APP_USER" ]; then
        gosu "$APP_USER" git -C "$REPO_DIR" "$@"
    else
        git -C "$REPO_DIR" "$@"
    fi
}

# Persistent benchmark volumes repeatedly fetch detached SHAs without advancing
# a remote-tracking ref. Those fetches can add another near-complete pack, while
# interrupted fetches leave large tmp_pack_* files behind. Bound that growth
# before a fetch needs scratch space: discard only Git's incomplete temporary
# packs, compact when the pack store is large or the volume is low, then fail
# closed if recovery did not leave enough room for a fetch.
maintain_object_store() {
    local pack_dir="$REPO_DIR/.git/objects/pack"
    local compact_at_kb="${CLOUDBENCH_GIT_COMPACT_AT_KB:-4194304}"
    local min_free_kb="${CLOUDBENCH_GIT_MIN_FREE_KB:-2097152}"
    local pack_kb free_kb

    [[ "$compact_at_kb" =~ ^[0-9]+$ ]] || {
        echo "[cloudbench] FATAL: CLOUDBENCH_GIT_COMPACT_AT_KB must be an integer" >&2
        return 1
    }
    [[ "$min_free_kb" =~ ^[0-9]+$ ]] || {
        echo "[cloudbench] FATAL: CLOUDBENCH_GIT_MIN_FREE_KB must be an integer" >&2
        return 1
    }

    if [ -d "$pack_dir" ]; then
        find "$pack_dir" -maxdepth 1 -type f -name 'tmp_pack_*' -delete
    fi
    pack_kb="$(du -sk "$pack_dir" 2>/dev/null | awk '{print $1}')"
    free_kb="$(df -Pk "$REPO_DIR" | awk 'NR == 2 {print $4}')"
    pack_kb="${pack_kb:-0}"
    free_kb="${free_kb:-0}"

    if [ "$pack_kb" -ge "$compact_at_kb" ] || [ "$free_kb" -lt "$min_free_kb" ]; then
        echo "[cloudbench] compacting persistent Git object store (pack_kb=$pack_kb free_kb=$free_kb)"
        git_cmd gc --prune=now
        free_kb="$(df -Pk "$REPO_DIR" | awk 'NR == 2 {print $4}')"
        free_kb="${free_kb:-0}"
    fi

    if [ "$free_kb" -lt "$min_free_kb" ]; then
        echo "[cloudbench] FATAL: insufficient volume space for git fetch (${free_kb}KB free; need ${min_free_kb}KB)" >&2
        return 1
    fi
}

acquire_fetch_lock

# A snapshot may retain an applied workspace patch while HEAD still names its
# fetchable base. Restore only changed tracked paths before the next patch;
# leave dependency trees, env files, and unrelated untracked data alone. Clean
# exact-SHA checkouts still skip writes, maintenance, and network fetches. A
# full-tree reset on a large /data/repo previously exhausted the SSH budget.
if [[ "$REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
    current="$(git_cmd rev-parse HEAD 2>/dev/null || true)"
    if [ "$(printf '%s' "$current" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$REF" | tr '[:upper:]' '[:lower:]')" ]; then
        tracked_paths="$(mktemp /tmp/cloudbench-tracked-paths.XXXXXX)"
        git_cmd diff --no-ext-diff --no-renames --name-only -z "$current" -- > "$tracked_paths"
        # Worktree and staged edits can cancel in a HEAD-to-worktree diff.
        # Include both path streams; Git treats repeated literal paths equally.
        git_cmd diff --no-ext-diff --no-renames --cached --name-only -z "$current" -- >> "$tracked_paths"
        if [ -s "$tracked_paths" ]; then
            [ -z "$APP_USER" ] || chown "$APP_USER" "$tracked_paths"
            git_cmd --literal-pathspecs restore --source="$current" --staged --worktree \
                --pathspec-from-file="$tracked_paths" --pathspec-file-nul
            if ! git_cmd diff --no-ext-diff --quiet "$current" -- \
                || ! git_cmd diff --no-ext-diff --cached --quiet "$current" --; then
                echo "[cloudbench] FATAL: tracked workspace did not match requested base" >&2
                exit 1
            fi
            echo "[cloudbench] restored tracked workspace at $current"
        fi
        echo "[cloudbench] already-at $current"
        exit 0
    fi
fi

stage_started="$(date +%s)"
maintain_object_store
echo "[cloudbench] git-maintenance $(( $(date +%s) - stage_started ))s"

remote_url="$(git_cmd remote get-url origin)"
if [[ "$remote_url" == https://github.com/* || "$remote_url" == *github.com/* ]]; then
    token=""
    if [ -n "${CLOUDBENCH_GITHUB_TOKEN_B64:-}" ]; then
        token="$(printf '%s' "$CLOUDBENCH_GITHUB_TOKEN_B64" | base64 -d 2>/dev/null || true)"
    fi
    if [ -z "$token" ]; then
        echo "[cloudbench] FATAL: controller GitHub token is unavailable" >&2
        exit 1
    fi
    # Remove any expired credential embedded by an old warm-box setup. The
    # current credential is request-scoped through http.extraheader and is never
    # persisted in the repository config.
    git_cmd remote set-url origin https://github.com/Rose-Ai-Labs/rose.git
    auth="Authorization: Basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
    auth_config="$(mktemp /tmp/cloudbench-gitconfig.XXXXXX)"
    printf '[http]\n\textraheader = %s\n' "$auth" > "$auth_config"
    chmod 600 "$auth_config"
    [ -n "$APP_USER" ] && chown "$APP_USER" "$auth_config"
fi

stage_started="$(date +%s)"
# This checkout has one relevant parent: its current HEAD. Advertising every
# historic detached ref wastes negotiation on persistent pool volumes. Object
# maintenance already ran above under our exact lock, so do not repeat Git's
# opportunistic auto-maintenance on every fresh-code boot.
fetch_args=(--no-tags --no-auto-gc)
if git_cmd rev-parse --verify HEAD >/dev/null 2>&1; then
    fetch_args+=(--negotiation-tip=HEAD)
elif [ "$fresh_checkout_admitted" = 1 ]; then
    # A fresh REAL volume needs the complete requested source, not historical
    # benchmark checkouts. Retained volumes keep their existing history above.
    fetch_args+=(--depth=1)
    if [ "$source_scope" = worker-runtime ]; then
        # Blobs outside the sparse definition are never transferred; checkout
        # fetches the rest once, under this request-scoped credential.
        git_cmd sparse-checkout set --no-cone '/*' "!/$worker_runtime_omitted"
        fetch_args+=(--filter=blob:none)
    fi
else
    echo "[cloudbench] FATAL: retained checkout has no verified HEAD" >&2
    exit 1
fi
git_cmd fetch "${fetch_args[@]}" origin "$REF" || fetch_status=$?
echo "[cloudbench] git-fetch $(( $(date +%s) - stage_started ))s"
if [ "${fetch_status:-0}" -ne 0 ]; then
    echo "[cloudbench] FATAL: could not fetch requested ref $REF" >&2
    exit 1
fi
fetched="$(git_cmd rev-parse FETCH_HEAD)"
if [[ "$REF" =~ ^[0-9a-fA-F]{40}$ ]] \
    && [ "$(printf '%s' "$fetched" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$REF" | tr '[:upper:]' '[:lower:]')" ]; then
    echo "[cloudbench] FATAL: fetched $fetched instead of requested SHA $REF" >&2
    exit 1
fi
stage_started="$(date +%s)"
git_cmd checkout -f "$fetched"
echo "[cloudbench] git-checkout $(( $(date +%s) - stage_started ))s"
stage_started="$(date +%s)"
git_cmd reset --hard "$fetched"
echo "[cloudbench] git-reset $(( $(date +%s) - stage_started ))s"
actual="$(git_cmd rev-parse HEAD)"
if [ "$actual" != "$fetched" ]; then
    echo "[cloudbench] FATAL: checkout verification failed ($actual != $fetched)" >&2
    exit 1
fi
if [ "$(git_cmd config --get core.sparseCheckout || true)" = true ]; then
    # Only the declared worker-runtime omission may be absent from the worktree.
    if git_cmd ls-files -t | grep '^S ' | cut -c3- \
        | grep -Ev '^agents/benchmarks/history/[^/]+\.jsonl$' | grep -q .; then
        echo "[cloudbench] FATAL: sparse worker checkout omitted runtime source" >&2
        exit 1
    fi
    echo "[cloudbench] worker-runtime checkout omits $worker_runtime_omitted"
fi
echo "[cloudbench] verified checkout $actual"
