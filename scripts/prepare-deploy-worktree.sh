#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Every repository question below names its worktree explicitly. An inherited
# GIT_DIR/GIT_COMMON_DIR (e.g. from a hook or another repo's tool shell) would
# answer for a different repository and select its port registry instead.
unset GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_PREFIX
# shellcheck source=lib/local-pg-image.sh
. "$SCRIPT_DIR/lib/local-pg-image.sh"
# One registry per repository, independent of TMPDIR: concurrent deploys that
# ran with different TMPDIR values (/tmp vs the documented Linux /var/tmp) used
# to claim from separate registries and received the same base port.
# Earlier TMPDIR-scoped registries keep reserving the ranges their live owners hold.
# ROSE_DEPLOY_LEGACY_PORT_REGISTRIES (colon-separated) replaces that set, e.g. in tests.
if [ -n "${ROSE_DEPLOY_LEGACY_PORT_REGISTRIES+x}" ]; then
  IFS=: read -r -a LEGACY_REGISTRIES <<<"$ROSE_DEPLOY_LEGACY_PORT_REGISTRIES"
else
  LEGACY_REGISTRIES=("${TMPDIR:-/tmp}/rose-deploy-worktree-ports-${UID}" "/tmp/rose-deploy-worktree-ports-${UID}" "/var/tmp/rose-deploy-worktree-ports-${UID}")
fi
ORIGINAL_ARGS=("$@")
WORKTREE=""
SOURCE_WORKSPACE=""
PORT_REGISTRY=""
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

system_pg_marker_path() {
  local root="${1:-${ROSE_DEPLOY_WORKTREE_PATH:-}}"
  printf '%s\n' "$root/.context/deploy-system-pg.db"
}

uses_system_pg() {
  local root="${1:-${ROSE_DEPLOY_WORKTREE_PATH:-}}"
  if [ "${ROSE_USE_SYSTEM_PG:-false}" = "true" ]; then
    return 0
  fi
  [ -n "$root" ] && [ -f "$(system_pg_marker_path "$root")" ]
}

persist_system_pg_mode() {
  # Durable across clean shells: --check must not depend on ambient env alone.
  local config="${1:-${ROSE_DEPLOY_WORKTREE_PATH:-}/.context/deploy-worktree.env}"
  export ROSE_USE_SYSTEM_PG=true
  mkdir -p "$(dirname "$config")"
  if [ -f "$config" ] && grep -Eq '^export ROSE_USE_SYSTEM_PG=true[[:space:]]*$' "$config"; then
    return 0
  fi
  printf 'export ROSE_USE_SYSTEM_PG=true\n' >>"$config"
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
    # Preserve Cloud system-Postgres mode across rewrite (marker or ambient).
    if uses_system_pg "$worktree"; then
      printf 'export ROSE_USE_SYSTEM_PG=true\n'
    fi
  } >"$temp"
  mv "$temp" "$config"
}

hydrate_seed_cache() {
  # Isolated deploy worktrees need the source's cached prod dump for
  # /deploy Step 4r (seed-memory-ratchet). Symlink — do not copy — so we
  # never duplicate ~30MB dumps per deploy unit.
  local target="$1"
  local source_workspace="$2"
  local src_cache="$source_workspace/.context/benchmarks/seed-cache"
  local dst_cache="$target/.context/benchmarks/seed-cache"
  if [ -d "$src_cache" ] && [ ! -e "$dst_cache" ]; then
    mkdir -p "$(dirname "$dst_cache")"
    ln -s "$src_cache" "$dst_cache"
  fi
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

# A venv copied from another checkout keeps that checkout's path in its
# activate script, so `source venv/bin/activate` (run.sh, run_local_worker.sh)
# runs the OTHER checkout's interpreter and packages while `venv/bin/python`
# runs this one. Activate it for real instead of parsing the script, whose
# shape differs across Python versions.
agents_venv_is_self_rooted() {
  local venv="$1"
  local activated
  [ -f "$venv/bin/activate" ] || return 1
  activated="$(
    bash -c '. "$1/bin/activate" >/dev/null 2>&1 && printf "%s" "${VIRTUAL_ENV:-}"' _ "$venv"
  )" || return 1
  [ -n "$activated" ] && [ -d "$activated" ] &&
    [ "$(canonical_dir "$activated")" = "$(canonical_dir "$venv")" ]
}

ensure_dependencies() {
  local target="$1"
  local source_workspace="$2"
  (
    cd "$target"
    # Nested .context worktrees can accidentally resolve dependencies by
    # walking up into the controller's node_modules. Require an installation
    # rooted in the deploy worktree before the generic workspace verifier.
    if [ ! -d node_modules ]; then
      echo "📦 Installing deploy-worktree root dependencies..."
      # No root lockfile is committed. Reuse the source workspace's verified
      # resolved tree when manifests match, instead of re-resolving the live
      # registry (which crashed npm's arborist on 2026-10-12).
      python3 scripts/lib/seed_root_npm_lockfile.py "$target" "$source_workspace"
      npm install --no-audit --no-fund
    fi
    local workspaces=(back-end front-end)
    if [ "$(uname -s)" = "Darwin" ] &&
      git rev-parse --verify origin/main >/dev/null 2>&1 &&
      ! git diff --quiet origin/main...HEAD -- mac-app; then
      workspaces+=(mac-app)
    fi
    bash scripts/ensure-workspace-dependencies.sh "${workspaces[@]}"
    if [ ! -x agents/venv/bin/python ] ||
      ! agents_venv_is_self_rooted agents/venv ||
      ! agents/venv/bin/python -c 'import browser_use, pytest, temporalio' >/dev/null 2>&1; then
      source_python="$source_workspace/agents/venv/bin/python"
      [ -x "$source_python" ] || source_python="$(command -v python3)"
      if [ -e agents/venv ]; then
        mv agents/venv "agents/venv.incomplete.$(date -u +%Y%m%d%H%M%S).$$"
      fi
      "$source_python" -m venv agents/venv
      agents/venv/bin/python -m pip install --upgrade pip
      agents/venv/bin/python -m pip install -r agents/requirements.txt
    elif ! agents/venv/bin/python scripts/lib/agents_venv_satisfied.py agents/requirements.txt; then
      agents/venv/bin/python -m pip install -r agents/requirements.txt
    fi
    agents/venv/bin/python -c 'import browser_use, pytest, temporalio' >/dev/null
    agents_venv_is_self_rooted agents/venv
  )
}

database_port() {
  printf '%s\n' "$((10#$CONDUCTOR_PORT + 5))"
}

system_deploy_db_name() {
  # Isolated DB name on shared system Postgres (Cloud: ROSE_USE_SYSTEM_PG).
  # Keep it SQL-safe and unique per worktree identity.
  local safe
  safe="$(printf '%s' "$CONDUCTOR_WORKSPACE_NAME" | tr -c '[:alnum:]' '_' | cut -c1-48)"
  printf 'victoria_deploy_%s\n' "$safe"
}

check_database() {
  local expected_port
  local actual_port
  local actual_owner
  local container="victoria-db-${CONDUCTOR_WORKSPACE_NAME}"
  local db_name
  local marker

  # Marker is authoritative so --check works without ambient ROSE_USE_SYSTEM_PG.
  if uses_system_pg "$ROSE_DEPLOY_WORKTREE_PATH"; then
    db_name="$(system_deploy_db_name)"
    marker="$(system_pg_marker_path "$ROSE_DEPLOY_WORKTREE_PATH")"
    if [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$db_name" ]; then
      echo "❌ Deploy system database marker missing or mismatched for $ROSE_DEPLOY_WORKTREE_PATH." >&2
      return 1
    fi
    pg_isready -h localhost -p 5432 -U postgres -q >/dev/null
    PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '$db_name'" | grep -q '^1$'
    return 0
  fi

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
  local db_name
  local marker
  local docker_rc=0

  if uses_system_pg "$ROSE_DEPLOY_WORKTREE_PATH"; then
    db_name="$(system_deploy_db_name)"
    marker="$(system_pg_marker_path "$ROSE_DEPLOY_WORKTREE_PATH")"
    persist_system_pg_mode "$ROSE_DEPLOY_WORKTREE_PATH/.context/deploy-worktree.env"
    if ! pg_isready -h localhost -p 5432 -U postgres -q 2>/dev/null; then
      sudo service postgresql start >/dev/null 2>&1 || true
    fi
    if ! pg_isready -h localhost -p 5432 -U postgres -q 2>/dev/null; then
      echo "❌ System Postgres is not ready on localhost:5432 (ROSE_USE_SYSTEM_PG=true)." >&2
      return 1
    fi
    PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '$db_name'" | grep -q '^1$' \
      || PGPASSWORD=postgres createdb -h localhost -p 5432 -U postgres "$db_name"
    mkdir -p "$(dirname "$marker")"
    printf '%s\n' "$db_name" >"$marker"
    echo "✅ Deploy worktree system database ready: $db_name on localhost:5432"
    return 0
  fi

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
    # Owned by this worktree: a pre-pgvector image is replaced (fresh volume).
    recreate_if_stale_pg_image "$container" "$volume"
  fi

  if docker ps -a --filter "name=^${container}$" --format '{{.Names}}' | grep -qx "$container"; then
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
    if ! docker run -d \
      --name "$container" \
      --label "ai.rose.deploy-worktree.path=$ROSE_DEPLOY_WORKTREE_PATH" \
      -e POSTGRES_PASSWORD=postgres \
      -e POSTGRES_DB=victoria \
      -p "$expected_port:5432" \
      -v "$volume:/var/lib/postgresql/data" \
      "$LOCAL_PG_IMAGE" >/dev/null; then
      docker_rc=$?
      # Cloud VMs often cannot overlay-mount images; fall back like setup-db.sh.
      echo "⚠️  Docker Postgres unavailable for deploy worktree (exit $docker_rc) — falling back to system Postgres."
      persist_system_pg_mode "$ROSE_DEPLOY_WORKTREE_PATH/.context/deploy-worktree.env"
      provision_database
      return $?
    fi
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
    # Cloud dev boxes have no Conductor-provided CONDUCTOR_WORKSPACE_PATH; their
    # primary checkout is identified by the cloud-build.sh .cloud-env rooted at
    # itself. A linked worktree is never primary, even with a copied .cloud-env.
    cloud_root="$(sed -n 's/^export CONDUCTOR_ROOT_PATH=//p' "$WORKTREE/.cloud-env" 2>/dev/null | tail -n 1)"
    if grep -qx '# rose-cloud-env' "$WORKTREE/.cloud-env" 2>/dev/null &&
      [ -n "$cloud_root" ] && [ -d "$cloud_root" ] &&
      [ "$(canonical_dir "$cloud_root")" = "$WORKTREE" ] &&
      [ "$(git_common_dir "$WORKTREE")" = "$(canonical_dir "$(git -C "$WORKTREE" rev-parse --absolute-git-dir)")" ]; then
      echo "✅ Primary cloud workspace does not require isolated deploy preparation."
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
  agents_venv_is_self_rooted "$WORKTREE/agents/venv" || {
    echo "❌ Deploy worktree agents/venv activates another checkout's environment (copied venv)." >&2
    echo "   Re-run deploy-worktree preparation to rebuild it in place." >&2
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

# The default registry lives in the repository's git common directory (shared
# by every worktree), resolved from the target worktree rather than this script.
DEFAULT_REGISTRY="$(git_common_dir "$WORKTREE")/rose-deploy-worktree-ports"
[ -n "$PORT_REGISTRY" ] || PORT_REGISTRY="$DEFAULT_REGISTRY"
mkdir -p "$WORKTREE/.context"
# `shasum` is a macOS-ism; Linux hosts ship coreutils' sha256sum instead. Both
# emit the same hex digest, so either satisfies the owner-lock identity.
deploy_worktree_sha256_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256
  else
    sha256sum
  fi
}
OWNER_HASH="$(printf '%s' "$WORKTREE" | deploy_worktree_sha256_stdin | awk '{print substr($1, 1, 12)}')"
if [ "${ROSE_DEPLOY_PREFLIGHT_LOCKED:-0}" != "1" ]; then
  exec python3 "$SCRIPT_DIR/deploy-worktree-lock.py" \
    --lock "$PORT_REGISTRY/owner-$OWNER_HASH.lock" \
    -- env ROSE_DEPLOY_PREFLIGHT_LOCKED=1 \
    bash "$0" "${ORIGINAL_ARGS[@]}"
fi
if [ -n "${ROSE_DEPLOY_PREFLIGHT_TEST_PAUSE_AFTER_LOCK:-}" ]; then
  sleep "$ROSE_DEPLOY_PREFLIGHT_TEST_PAUSE_AFTER_LOCK"
fi
RESPECT_ARGS=()
if [ "$PORT_REGISTRY" = "$DEFAULT_REGISTRY" ]; then
  for legacy in ${LEGACY_REGISTRIES[@]+"${LEGACY_REGISTRIES[@]}"}; do
    RESPECT_ARGS+=(--respect-registry "$legacy")
  done
fi
BASE_PORT="$(python3 "$SCRIPT_DIR/deploy-worktree-port.py" claim \
  --registry "$PORT_REGISTRY" \
  --owner "$WORKTREE" ${RESPECT_ARGS[@]+"${RESPECT_ARGS[@]}"})"
WORKSPACE_BASENAME="$(printf '%s' "$(basename "$WORKTREE")" | tr -c '[:alnum:]_.-' '-')"
WORKSPACE_NAME="${WORKSPACE_BASENAME:0:48}-${OWNER_HASH}"
CONFIG="$WORKTREE/.context/deploy-worktree.env"
write_config "$CONFIG" "$WORKTREE" "$SOURCE_WORKSPACE" "$WORKSPACE_NAME" "$BASE_PORT"
hydrate_env_files "$WORKTREE" "$SOURCE_WORKSPACE"
hydrate_seed_cache "$WORKTREE" "$SOURCE_WORKSPACE"

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
