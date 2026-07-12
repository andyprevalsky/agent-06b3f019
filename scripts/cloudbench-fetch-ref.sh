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
