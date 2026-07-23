#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REGISTRY="${TMPDIR:-/tmp}/rose-deploy-worktree-ports-${UID}"
ORIGINAL_ARGS=("$@")
WORKTREE=""
SOURCE_WORKSPACE=""
PORT_REGISTRY="$DEFAULT_REGISTRY"
CHECK_ONLY=false
SKIP_DEPENDENCIES=false
SKIP_DATABASE=false

usage() {
  cat >&2 <<'EOF'
usage:
  prepare-deploy-worktree.sh --worktree PATH --source PATH [options]
  prepare-deploy-worktree.sh --check

options:
  --port-registry PATH
  --skip-dependencies
  --skip-database
EOF
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --worktree)
      [ "$#" -ge 2 ] || usage
      WORKTREE="$2"
      shift 2
      ;;
    --source)
      [ "$#" -ge 2 ] || usage
      SOURCE_WORKSPACE="$2"
      shift 2
      ;;
    --port-registry)
      [ "$#" -ge 2 ] || usage
      PORT_REGISTRY="$2"
      shift 2
      ;;
    --check)
      CHECK_ONLY=true
      shift
      ;;
    --skip-dependencies)
      SKIP_DEPENDENCIES=true
      shift
      ;;
    --skip-database)
      SKIP_DATABASE=true
      shift
      ;;
    *)
      usage
      ;;
  esac
done

canonical_dir() {
  (cd "$1" && pwd -P)
}

resolved_path() {
  python3 - "$1" <<'PY'
from pathlib import Path
import sys

print(Path(sys.argv[1]).resolve(strict=True))
PY
}

git_common_dir() {
  local repo="$1"
  local common
  common="$(git -C "$repo" rev-parse --git-common-dir)"
  if [[ "$common" = /* ]]; then
    canonical_dir "$common"
  else
    canonical_dir "$repo/$common"
  fi
}

write_config() {
  local config="$1"
  local worktree="$2"
  local source_workspace="$3"
  local workspace_name="$4"
  local base_port="$5"
  local temp="${config}.tmp.$$"
  {
    printf 'export ROSE_DEPLOY_WORKTREE=1\n'
    printf 'export ROSE_DEPLOY_WORKTREE_PATH=%q\n' "$worktree"
    printf 'export ROSE_DEPLOY_SOURCE_WORKSPACE=%q\n' "$source_workspace"
    printf 'export ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1\n'
    printf 'export CONDUCTOR_WORKSPACE_PATH=%q\n' "$worktree"
    printf 'export CONDUCTOR_WORKSPACE_NAME=%q\n' "$workspace_name"
    printf 'export CONDUCTOR_PORT=%q\n' "$base_port"
  } >"$temp"
  mv "$temp" "$config"
}

hydrate_env_files() {
  local target="$1"
  local source_workspace="$2"
  local relative
  for relative in back-end/.env agents/.env front-end/.env mac-app/.env; do
    if [ ! -e "$source_workspace/$relative" ]; then
      continue
    fi
    mkdir -p "$target/$(dirname "$relative")"
    if [ -e "$target/$relative" ] || [ -L "$target/$relative" ]; then
      if [ ! -L "$target/$relative" ]; then
        echo "❌ Refusing to replace non-symlink deploy credential file: $target/$relative" >&2
        return 1
      fi
      if [ "$(resolved_path "$target/$relative")" != "$(resolved_path "$source_workspace/$relative")" ]; then
        echo "❌ Deploy credential link does not target the selected source workspace: $target/$relative" >&2
        return 1
      fi
      continue
    fi
    ln -s "$source_workspace/$relative" "$target/$relative"
  done
}

check_env_files() {
  local target="$1"
  local source_workspace="$2"
  local relative
  for relative in back-end/.env agents/.env; do
    if [ ! -L "$target/$relative" ]; then
      echo "❌ Deploy worktree credential must be a hydrated symlink: $relative" >&2
      return 1
    fi
    if [ "$(resolved_path "$target/$relative")" != "$(resolved_path "$source_workspace/$relative")" ]; then
      echo "❌ Deploy worktree credential points outside its selected source: $relative" >&2
      return 1
    fi
  done
}

ensure_dependencies() {
  local target="$1"
  local source_workspace="$2"
  (
    cd "$target"
    local workspaces=(back-end front-end)
    if [ "$(uname -s)" = "Darwin" ] &&
      git rev-parse --verify origin/main >/dev/null 2>&1 &&
      ! git diff --quiet origin/main...HEAD -- mac-app; then
      workspaces+=(mac-app)
    fi
    bash scripts/ensure-workspace-dependencies.sh "${workspaces[@]}"
    if [ ! -x agents/venv/bin/python ] ||
      ! agents/venv/bin/python -c 'import browser_use, pytest, temporalio' >/dev/null 2>&1; then
      source_python="$source_workspace/agents/venv/bin/python"
      [ -x "$source_python" ] || source_python="$(command -v python3)"
      if [ -e agents/venv ]; then
        mv agents/venv "agents/venv.incomplete.$(date -u +%Y%m%d%H%M%S).$$"
      fi
      "$source_python" -m venv agents/venv
      agents/venv/bin/python -m pip install --upgrade pip
      agents/venv/bin/python -m pip install -r agents/requirements.txt
    fi
    agents/venv/bin/python -c 'import browser_use, pytest, temporalio' >/dev/null
  )
}

database_port() {
  printf '%s\n' "$((10#$CONDUCTOR_PORT + 5))"
}

check_database() {
  local expected_port
  local actual_port
  local actual_owner
  local container="victoria-db-${CONDUCTOR_WORKSPACE_NAME}"
  expected_port="$(database_port)"
  actual_owner="$(docker inspect "$container" \
    --format='{{index .Config.Labels "ai.rose.deploy-worktree.path"}}' \
    2>/dev/null || true)"
  actual_port="$(docker inspect "$container" \
    --format='{{if .State.Running}}{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostPort}}{{end}}' \
    2>/dev/null || true)"
  if [ "$actual_owner" != "$ROSE_DEPLOY_WORKTREE_PATH" ]; then
    echo "❌ Deploy database $container is not labeled for $ROSE_DEPLOY_WORKTREE_PATH." >&2
    return 1
  fi
  if [ "$actual_port" != "$expected_port" ]; then
    echo "❌ Deploy worktree database $container is not running on owned port $expected_port." >&2
    return 1
  fi
  docker exec "$container" pg_isready -U postgres -q >/dev/null
}

provision_database() {
  local expected_port
  local actual_port
  local actual_owner
  local container="victoria-db-${CONDUCTOR_WORKSPACE_NAME}"
  local volume="victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME}"
  expected_port="$(database_port)"

  if docker ps -a --filter "name=^${container}$" --format '{{.Names}}' | grep -qx "$container"; then
    actual_owner="$(docker inspect "$container" \
      --format='{{index .Config.Labels "ai.rose.deploy-worktree.path"}}' \
      2>/dev/null || true)"
    if [ "$actual_owner" != "$ROSE_DEPLOY_WORKTREE_PATH" ]; then
      echo "❌ Existing deploy database $container belongs to ${actual_owner:-an unlabeled owner}." >&2
      echo "   Refusing to adopt or delete a foreign container." >&2
      return 1
    fi
    actual_port="$(docker inspect "$container" \
      --format='{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostPort}}' \
      2>/dev/null || true)"
    if [ "$actual_port" != "$expected_port" ]; then
      echo "❌ Existing deploy database $container owns port $actual_port, expected $expected_port." >&2
      echo "   Refusing to delete or repurpose it; diagnose cleanup separately." >&2
      return 1
    fi
    docker start "$container" >/dev/null 2>&1 || true
  else
    docker run -d \
      --name "$container" \
      --label "ai.rose.deploy-worktree.path=$ROSE_DEPLOY_WORKTREE_PATH" \
      -e POSTGRES_PASSWORD=postgres \
      -e POSTGRES_DB=victoria \
      -p "$expected_port:5432" \
      -v "$volume:/var/lib/postgresql/data" \
      postgres:16-alpine >/dev/null
  fi

  for attempt in $(seq 1 30); do
    if docker exec "$container" pg_isready -U postgres -q >/dev/null 2>&1; then
      echo "✅ Deploy worktree database ready: $container on $expected_port"
      return 0
    fi
    if [ "$attempt" -eq 30 ]; then
      echo "❌ Deploy worktree database did not become ready: $container" >&2
      return 1
    fi
    sleep 1
  done
}

if $CHECK_ONLY; then
  WORKTREE="$(git rev-parse --show-toplevel)"
  WORKTREE="$(canonical_dir "$WORKTREE")"
  CONFIG="$WORKTREE/.context/deploy-worktree.env"
  if [ ! -f "$CONFIG" ]; then
    inherited_path="${CONDUCTOR_WORKSPACE_PATH:-}"
    if [ -n "$inherited_path" ] && [ -d "$inherited_path" ] &&
      [ "$(canonical_dir "$inherited_path")" = "$WORKTREE" ]; then
      echo "✅ Primary Conductor worktree does not require isolated deploy preparation."
      exit 0
    fi
    echo "❌ Isolated deploy worktree is missing .context/deploy-worktree.env." >&2
    echo "   Run /descend preparation before starting /deploy." >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  . "$CONFIG"
  [ "${ROSE_DEPLOY_WORKTREE_PATH:-}" = "$WORKTREE" ] || {
    echo "❌ Deploy worktree config belongs to ${ROSE_DEPLOY_WORKTREE_PATH:-unknown}, not $WORKTREE." >&2
    exit 1
  }
  check_env_files "$WORKTREE" "$ROSE_DEPLOY_SOURCE_WORKSPACE"
  [ -x "$WORKTREE/agents/venv/bin/python" ] || {
    echo "❌ Deploy worktree is missing agents/venv." >&2
    exit 1
  }
  [ -d "$WORKTREE/node_modules" ] || {
    echo "❌ Deploy worktree is missing node_modules." >&2
    exit 1
  }
  check_database
  echo "✅ Isolated deploy worktree preparation is complete."
  exit 0
fi

[ -n "$WORKTREE" ] && [ -n "$SOURCE_WORKSPACE" ] || usage
WORKTREE="$(canonical_dir "$WORKTREE")"
SOURCE_WORKSPACE="$(canonical_dir "$SOURCE_WORKSPACE")"
[ "$WORKTREE" != "$SOURCE_WORKSPACE" ] || {
  echo "❌ Deploy worktree must differ from its source workspace." >&2
  exit 1
}
[ "$(git_common_dir "$WORKTREE")" = "$(git_common_dir "$SOURCE_WORKSPACE")" ] || {
  echo "❌ Deploy worktree and source workspace do not share the same Git repository." >&2
  exit 1
}

mkdir -p "$WORKTREE/.context"
OWNER_HASH="$(printf '%s' "$WORKTREE" | shasum -a 256 | awk '{print substr($1, 1, 12)}')"
if [ "${ROSE_DEPLOY_PREFLIGHT_LOCKED:-0}" != "1" ]; then
  exec python3 "$SCRIPT_DIR/deploy-worktree-lock.py" \
    --lock "$PORT_REGISTRY/owner-$OWNER_HASH.lock" \
    -- env ROSE_DEPLOY_PREFLIGHT_LOCKED=1 \
    bash "$0" "${ORIGINAL_ARGS[@]}"
fi
if [ -n "${ROSE_DEPLOY_PREFLIGHT_TEST_PAUSE_AFTER_LOCK:-}" ]; then
  sleep "$ROSE_DEPLOY_PREFLIGHT_TEST_PAUSE_AFTER_LOCK"
fi
BASE_PORT="$(python3 "$SCRIPT_DIR/deploy-worktree-port.py" claim \
  --registry "$PORT_REGISTRY" \
  --owner "$WORKTREE")"
WORKSPACE_BASENAME="$(printf '%s' "$(basename "$WORKTREE")" | tr -c '[:alnum:]_.-' '-')"
WORKSPACE_NAME="${WORKSPACE_BASENAME:0:48}-${OWNER_HASH}"
CONFIG="$WORKTREE/.context/deploy-worktree.env"
write_config "$CONFIG" "$WORKTREE" "$SOURCE_WORKSPACE" "$WORKSPACE_NAME" "$BASE_PORT"
hydrate_env_files "$WORKTREE" "$SOURCE_WORKSPACE"

# shellcheck disable=SC1090
. "$CONFIG"
if ! $SKIP_DEPENDENCIES; then
  ensure_dependencies "$WORKTREE" "$SOURCE_WORKSPACE"
fi
if ! $SKIP_DATABASE; then
  provision_database
fi

echo "✅ Prepared isolated deploy worktree $WORKTREE"
echo "   identity=$CONDUCTOR_WORKSPACE_NAME base_port=$CONDUCTOR_PORT"
