#!/usr/bin/env bash
# Fetch and verify the exact ref a cloud benchmark was asked to execute. Never
# fall back to a prior FETCH_HEAD: stale code is worse than a loud infra failure.
set -euo pipefail

REPO_DIR="${1:?usage: cloudbench-fetch-ref.sh <repo-dir> <ref>}"
REF="${2:?usage: cloudbench-fetch-ref.sh <repo-dir> <ref>}"
APP_USER="${CLOUDBENCH_APP_USER:-}"
auth_config=""

cleanup() {
    [ -n "$auth_config" ] && rm -f "$auth_config" 2>/dev/null || true
}
trap cleanup EXIT

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
# packs, compact when the
# pack store is large or the volume is low, then fail closed if recovery did not
# leave enough room for a fetch.
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

maintain_object_store

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

git_cmd fetch --no-tags origin "$REF" || fetch_status=$?
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
git_cmd checkout -f "$fetched"
git_cmd reset --hard "$fetched"
actual="$(git_cmd rev-parse HEAD)"
if [ "$actual" != "$fetched" ]; then
    echo "[cloudbench] FATAL: checkout verification failed ($actual != $fetched)" >&2
    exit 1
fi
echo "[cloudbench] verified checkout $actual"
