#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFLIGHT="$ROOT_DIR/scripts/prepare-deploy-worktree.sh"
WORKSPACE_ENV="$ROOT_DIR/scripts/lib/workspace-env.sh"
DESCEND_COMMAND="$ROOT_DIR/.claude/commands/descend.md"
DEPLOY_COMMAND="$ROOT_DIR/.claude/commands/deploy.md"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

expect_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [ "$actual" != "$expected" ]; then
    fail "$label: got '$actual', expected '$expected'"
  fi
  echo "PASS: $label"
}

require_text() {
  local file="$1"
  local text="$2"
  local label="$3"
  grep -Fq -- "$text" "$file" || fail "$label"
}

[ -x "$PREFLIGHT" ] || fail "deploy-worktree preflight must be executable"

controller="$TMP_ROOT/controller"
deploy_one="$TMP_ROOT/descend-I99-one"
deploy_two="$TMP_ROOT/descend-I99-two"
registry="$TMP_ROOT/ports"
git init -q "$controller"
git -C "$controller" config user.email test@example.com
git -C "$controller" config user.name Test
printf 'fixture\n' >"$controller/README.md"
git -C "$controller" add README.md
git -C "$controller" commit -qm init
git -C "$controller" worktree add -q -b deploy-one "$deploy_one"
git -C "$controller" worktree add -q -b deploy-two "$deploy_two"
controller="$(cd "$controller" && pwd -P)"
deploy_one="$(cd "$deploy_one" && pwd -P)"
deploy_two="$(cd "$deploy_two" && pwd -P)"

for relative in back-end/.env agents/.env front-end/.env mac-app/.env; do
  mkdir -p "$controller/$(dirname "$relative")"
  printf 'FIXTURE_ENV=1\n' >"$controller/$relative"
done

bash "$PREFLIGHT" \
  --worktree "$deploy_one" \
  --source "$controller" \
  --port-registry "$registry" \
  --skip-dependencies \
  --skip-database

for relative in back-end/.env agents/.env front-end/.env mac-app/.env; do
  [ -L "$deploy_one/$relative" ] || fail "$relative must be hydrated as a source-workspace symlink"
  expect_eq "$(readlink "$deploy_one/$relative")" "$controller/$relative" "$relative targets the controller credential file"
done

identity="$(
  cd "$deploy_one"
  CONDUCTOR_PORT=55040 \
  CONDUCTOR_WORKSPACE_NAME=parent-name \
  CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash -c ". '$WORKSPACE_ENV'; normalize_conductor_workspace_env; printf '%s\\n' \"\$CONDUCTOR_WORKSPACE_PATH\" \"\$CONDUCTOR_WORKSPACE_NAME\" \"\$CONDUCTOR_PORT\""
)"
expect_eq "$(printf '%s\n' "$identity" | sed -n '1p')" "$deploy_one" "child worktree path replaces inherited parent identity"
expect_eq "$(printf '%s\n' "$identity" | sed -n '2p')" "$(basename "$deploy_one")" "child worktree name replaces inherited parent identity"
deploy_one_port="$(printf '%s\n' "$identity" | sed -n '3p')"
[[ "$deploy_one_port" =~ ^[1-9][0-9]{4}$ ]] || fail "child worktree receives a valid persistent base port"

bash "$PREFLIGHT" \
  --worktree "$deploy_one" \
  --source "$controller" \
  --port-registry "$registry" \
  --skip-dependencies \
  --skip-database
deploy_one_port_again="$(
  cd "$deploy_one"
  CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash -c ". '$WORKSPACE_ENV'; normalize_conductor_workspace_env; printf '%s' \"\$CONDUCTOR_PORT\""
)"
expect_eq "$deploy_one_port_again" "$deploy_one_port" "deploy worktree port claim is idempotent"

bash "$PREFLIGHT" \
  --worktree "$deploy_two" \
  --source "$controller" \
  --port-registry "$registry" \
  --skip-dependencies \
  --skip-database
deploy_two_port="$(
  cd "$deploy_two"
  CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash -c ". '$WORKSPACE_ENV'; normalize_conductor_workspace_env; printf '%s' \"\$CONDUCTOR_PORT\""
)"
[ "$deploy_two_port" != "$deploy_one_port" ] || fail "parallel deploy worktrees must receive distinct port ranges"
echo "PASS: parallel deploy worktrees receive distinct port ranges"

require_text "$DESCEND_COMMAND" 'bash scripts/prepare-deploy-worktree.sh' "/descend must hydrate and provision each isolated deploy worktree"
require_text "$DEPLOY_COMMAND" 'bash scripts/prepare-deploy-worktree.sh --check' "/deploy must fail closed when isolated-worktree preparation is incomplete"
require_text "$DEPLOY_COMMAND" 'bash scripts/tests/deploy-worktree-preflight.test.sh' "/deploy structural gates must cement deploy-worktree preparation"

echo "All deploy-worktree preflight tests passed."
