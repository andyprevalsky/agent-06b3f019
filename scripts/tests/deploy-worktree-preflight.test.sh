#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFLIGHT="$ROOT_DIR/scripts/prepare-deploy-worktree.sh"
WORKSPACE_ENV="$ROOT_DIR/scripts/lib/workspace-env.sh"
DESCEND_COMMAND="$ROOT_DIR/.claude/commands/descend.md"
DEPLOY_COMMAND="$ROOT_DIR/.claude/commands/deploy.md"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# Docker ownership cases must not inherit Cloud ROSE_USE_SYSTEM_PG=true.
# System-Postgres behavior is covered explicitly later in this suite.
unset ROSE_USE_SYSTEM_PG || true

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
deploy_two="$TMP_ROOT/sibling/descend-I99-one"
deploy_system="$TMP_ROOT/descend-I99-system"
registry="$TMP_ROOT/ports"
fake_bin="$TMP_ROOT/bin"
fake_docker_state="$TMP_ROOT/fake-docker"
mkdir -p "$(dirname "$deploy_two")" "$fake_bin" "$fake_docker_state"
cat >"$fake_bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_DOCKER_STATE:?}"
command="$1"
shift
case "$command" in
  ps)
    if [ -f "$state/container" ]; then
      sed -n '1p' "$state/container"
    fi
    ;;
  run)
    name=""
    port=""
    owner=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --label) owner="${2#ai.rose.deploy-worktree.path=}"; shift 2 ;;
        -p) port="${2%%:*}"; shift 2 ;;
        -e|-v) shift 2 ;;
        -d) shift ;;
        *) shift ;;
      esac
    done
    printf '%s\n%s\n%s\nrunning\n' "$name" "$port" "$owner" >"$state/container"
    printf 'fake-container-id\n'
    ;;
  inspect)
    name="$1"
    shift
    [ -f "$state/container" ] || exit 1
    [ "$(sed -n '1p' "$state/container")" = "$name" ] || exit 1
    format="${1:-}"
    case "$format" in
      *Labels*) sed -n '3p' "$state/container" ;;
      *State.Running*) sed -n '2p' "$state/container" ;;
      *PortBindings*) sed -n '2p' "$state/container" ;;
      *) sed -n '2p' "$state/container" ;;
    esac
    ;;
  start)
    ;;
  exec)
    exit 0
    ;;
  *)
    echo "unexpected fake docker command: $command" >&2
    exit 1
    ;;
esac
DOCKER
chmod +x "$fake_bin/docker"
git init -q "$controller"
git -C "$controller" config user.email test@example.com
git -C "$controller" config user.name Test
printf 'fixture\n' >"$controller/README.md"
git -C "$controller" add README.md
git -C "$controller" commit -qm init
git -C "$controller" worktree add -q -b deploy-one "$deploy_one"
git -C "$controller" worktree add -q -b deploy-two "$deploy_two"
git -C "$controller" worktree add -q -b deploy-system "$deploy_system"
controller="$(cd "$controller" && pwd -P)"
deploy_one="$(cd "$deploy_one" && pwd -P)"
deploy_two="$(cd "$deploy_two" && pwd -P)"
deploy_system="$(cd "$deploy_system" && pwd -P)"

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
deploy_one_name="$(printf '%s\n' "$identity" | sed -n '2p')"
[[ "$deploy_one_name" == "$(basename "$deploy_one")"-???????????? ]] || fail "child worktree name must include a path-derived ownership suffix"
echo "PASS: child worktree name replaces inherited parent identity with a unique identity"
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
deploy_two_name="$(
  cd "$deploy_two"
  CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash -c ". '$WORKSPACE_ENV'; normalize_conductor_workspace_env; printf '%s' \"\$CONDUCTOR_WORKSPACE_NAME\""
)"
[ "$deploy_two_name" != "$deploy_one_name" ] || fail "same-basename deploy worktrees must receive path-unique resource identities"
echo "PASS: same-basename deploy worktrees receive path-unique resource identities"

mkdir -p "$deploy_one/node_modules" "$deploy_one/agents/venv/bin"
printf '#!/usr/bin/env bash\nexit 0\n' >"$deploy_one/agents/venv/bin/python"
chmod +x "$deploy_one/agents/venv/bin/python"
PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
  bash "$PREFLIGHT" \
    --worktree "$deploy_one" \
    --source "$controller" \
    --port-registry "$registry" \
    --skip-dependencies
(
  cd "$deploy_one"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
    CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash "$PREFLIGHT" --check
)
expect_eq "$(sed -n '3p' "$fake_docker_state/container")" "$deploy_one" "owned database carries the canonical worktree label"

foreign_state="$TMP_ROOT/foreign-container"
cp "$fake_docker_state/container" "$foreign_state"
awk 'NR == 3 {$0 = "/tmp/foreign-worktree"} {print}' \
  "$fake_docker_state/container" >"$fake_docker_state/container.tmp"
mv "$fake_docker_state/container.tmp" "$fake_docker_state/container"
set +e
foreign_check_output="$(
  cd "$deploy_one"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
    CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash "$PREFLIGHT" --check 2>&1
)"
foreign_check_status=$?
foreign_prepare_output="$(
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
    bash "$PREFLIGHT" --worktree "$deploy_one" --source "$controller" \
      --port-registry "$registry" --skip-dependencies 2>&1
)"
foreign_prepare_status=$?
set -e
[ "$foreign_check_status" -ne 0 ] || fail "preflight check must reject a foreign database owner"
[ "$foreign_prepare_status" -ne 0 ] || fail "preparation must refuse to adopt a foreign database owner"
[[ "$foreign_check_output" == *"not labeled for"* ]] || fail "foreign database check failure must name the ownership boundary"
[[ "$foreign_prepare_output" == *"Refusing to adopt or delete a foreign container"* ]] || fail "foreign database preparation failure must explain non-adoption"
expect_eq "$(sed -n '3p' "$fake_docker_state/container")" "/tmp/foreign-worktree" "foreign database metadata remains untouched"
cp "$foreign_state" "$fake_docker_state/container"
echo "PASS: foreign database ownership fails closed without adoption or deletion"

rm -f "$fake_docker_state/container"
set +e
missing_db_output="$(
  cd "$deploy_one"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
    CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash "$PREFLIGHT" --check 2>&1
)"
missing_db_status=$?
set -e
[ "$missing_db_status" -ne 0 ] || fail "preflight check must reject a missing owned database"
[[ "$missing_db_output" == *"is not labeled for"* ]] || fail "missing database check failure must be explicit"
echo "PASS: missing owned database fails the deploy preflight"

PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
  bash "$PREFLIGHT" --worktree "$deploy_one" --source "$controller" \
    --port-registry "$registry" --skip-dependencies >/dev/null
set +e
ln -sfn "$controller/front-end/.env" "$deploy_one/agents/.env"
wrong_env_output="$(
  cd "$deploy_one"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
    CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash "$PREFLIGHT" --check 2>&1
)"
wrong_env_status=$?
set -e
[ "$wrong_env_status" -ne 0 ] || fail "preflight check must reject a credential link outside the selected source"
[[ "$wrong_env_output" == *"credential points outside its selected source"* ]] || fail "credential mismatch failure must be explicit"
ln -sfn "$controller/agents/.env" "$deploy_one/agents/.env"
echo "PASS: credential hydration fails closed on a mismatched target"

rm -f "$fake_docker_state/container"
first_log="$TMP_ROOT/concurrent-one.log"
second_log="$TMP_ROOT/concurrent-two.log"
PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
  ROSE_DEPLOY_PREFLIGHT_TEST_PAUSE_AFTER_LOCK=0.2 \
  bash "$PREFLIGHT" --worktree "$deploy_one" --source "$controller" \
    --port-registry "$registry" --skip-dependencies >"$first_log" 2>&1 &
first_pid=$!
PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
  ROSE_DEPLOY_PREFLIGHT_TEST_PAUSE_AFTER_LOCK=0.2 \
  bash "$PREFLIGHT" --worktree "$deploy_one" --source "$controller" \
    --port-registry "$registry" --skip-dependencies >"$second_log" 2>&1 &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
echo "PASS: same-owner concurrent preparation is serialized"

critical_dir="$TMP_ROOT/critical-section"
lock_path="$TMP_ROOT/direct-owner.lock"
python3 "$ROOT_DIR/scripts/deploy-worktree-lock.py" --lock "$lock_path" -- \
  bash -c 'mkdir "$1" || exit 91; sleep 0.3; rmdir "$1"' _ "$critical_dir" &
critical_one=$!
sleep 0.05
python3 "$ROOT_DIR/scripts/deploy-worktree-lock.py" --lock "$lock_path" -- \
  bash -c 'mkdir "$1" || exit 91; sleep 0.3; rmdir "$1"' _ "$critical_dir" &
critical_two=$!
wait "$critical_one"
wait "$critical_two"
echo "PASS: owner lock prevents measurable critical-section overlap"

signal_lock="$TMP_ROOT/signal-owner.lock"
first_entered="$TMP_ROOT/first-entered"
second_entered="$TMP_ROOT/second-entered"
python3 "$ROOT_DIR/scripts/deploy-worktree-lock.py" --lock "$signal_lock" -- \
  bash -c 'touch "$1"; sleep 0.5' _ "$first_entered" &
signal_wrapper=$!
for _ in $(seq 1 50); do
  [ -e "$first_entered" ] && break
  sleep 0.01
done
[ -e "$first_entered" ] || fail "signal-retention fixture did not enter its transaction"
kill "$signal_wrapper"
wait "$signal_wrapper" 2>/dev/null || true
python3 "$ROOT_DIR/scripts/deploy-worktree-lock.py" --lock "$signal_lock" -- \
  touch "$second_entered" &
signal_second=$!
sleep 0.1
[ ! -e "$second_entered" ] || fail "terminating the wrapper must not release the lock while its child is alive"
wait "$signal_second"
[ -e "$second_entered" ] || fail "waiting preparation must enter after the orphaned child exits"
echo "PASS: owner lock survives wrapper termination until the transaction child exits"

require_text "$DESCEND_COMMAND" 'bash scripts/prepare-deploy-worktree.sh' "/descend must hydrate and provision each isolated deploy worktree"
require_text "$DEPLOY_COMMAND" 'bash scripts/prepare-deploy-worktree.sh --check' "/deploy must fail closed when isolated-worktree preparation is incomplete"
require_text "$DEPLOY_COMMAND" 'bash scripts/tests/deploy-worktree-preflight.test.sh' "/deploy structural gates must cement deploy-worktree preparation"
require_text "$PREFLIGHT" 'if [ ! -d node_modules ]; then' "dependency hydration must not borrow the controller's node_modules through parent resolution"
require_text "$PREFLIGHT" 'ROSE_USE_SYSTEM_PG' "deploy-worktree prep must support system Postgres when Docker overlay mounts fail"
require_text "$PREFLIGHT" 'system_deploy_db_name' "deploy-worktree prep must isolate system Postgres databases per worktree"
require_text "$PREFLIGHT" 'persist_system_pg_mode' "system Postgres mode must persist into deploy-worktree.env for clean-shell --check"
require_text "$PREFLIGHT" 'hydrate_seed_cache' "deploy-worktree prep must hydrate seed-cache for the seed-memory ratchet"

# System Postgres path: durable marker + env so --check works without ambient flag.
mkdir -p "$deploy_system/node_modules" "$deploy_system/agents/venv/bin"
printf '#!/usr/bin/env bash\nexit 0\n' >"$deploy_system/agents/venv/bin/python"
chmod +x "$deploy_system/agents/venv/bin/python"
if ! command -v pg_isready >/dev/null 2>&1 || ! pg_isready -h localhost -p 5432 -U postgres -q 2>/dev/null; then
  fail "system Postgres on localhost:5432 is required to cement ROSE_USE_SYSTEM_PG deploy-worktree prep"
fi
ROSE_USE_SYSTEM_PG=true PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
  bash "$PREFLIGHT" \
    --worktree "$deploy_system" \
    --source "$controller" \
    --port-registry "$registry" \
    --skip-dependencies
system_name="$(
  # shellcheck disable=SC1091
  . "$deploy_system/.context/deploy-worktree.env"
  printf '%s' "$CONDUCTOR_WORKSPACE_NAME"
)"
system_db="victoria_deploy_$(printf '%s' "$system_name" | tr -c '[:alnum:]' '_' | cut -c1-48)"
trap 'PGPASSWORD=postgres dropdb -h localhost -p 5432 -U postgres --if-exists "$system_db" >/dev/null 2>&1 || true; rm -rf "$TMP_ROOT"' EXIT
grep -Eq '^export ROSE_USE_SYSTEM_PG=true[[:space:]]*$' \
  "$deploy_system/.context/deploy-worktree.env" \
  || fail "system Postgres prepare must persist ROSE_USE_SYSTEM_PG into deploy-worktree.env"
expect_eq "$(cat "$deploy_system/.context/deploy-system-pg.db")" "$system_db" \
  "system Postgres prepare writes the isolated database marker"
PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$system_db'" | grep -q '^1$' \
  || fail "system Postgres prepare must create the isolated database"
# Clean-shell --check: only the persisted env file, no ambient ROSE_USE_SYSTEM_PG.
env -u ROSE_USE_SYSTEM_PG \
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
  bash -c "
    cd \"$deploy_system\"
    # shellcheck disable=SC1091
    . .context/deploy-worktree.env
    bash \"$PREFLIGHT\" --check
  " >/dev/null
echo "PASS: system Postgres --check succeeds from persisted deploy-worktree.env alone"
rm -f "$deploy_system/.context/deploy-system-pg.db"
set +e
missing_marker_output="$(
  env -u ROSE_USE_SYSTEM_PG \
    PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
    bash -c "
      cd \"$deploy_system\"
      # shellcheck disable=SC1091
      . .context/deploy-worktree.env
      bash \"$PREFLIGHT\" --check
    " 2>&1
)"
missing_marker_status=$?
set -e
[ "$missing_marker_status" -ne 0 ] || fail "system Postgres --check must reject a missing marker"
[[ "$missing_marker_output" == *"marker missing or mismatched"* ]] \
  || fail "system Postgres missing-marker failure must be explicit"
echo "PASS: system Postgres missing marker fails the deploy preflight"

echo "All deploy-worktree preflight tests passed."
