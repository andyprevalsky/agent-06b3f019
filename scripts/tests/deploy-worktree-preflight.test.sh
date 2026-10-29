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

# Minimal venv fixture: an interpreter stub plus an activate script that roots
# the environment at $2 (the venv itself unless a test simulates a copy).
write_fake_venv() {
  local venv="$1"
  local activates_to="${2:-$1}"
  mkdir -p "$venv/bin"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$venv/bin/python"
  chmod +x "$venv/bin/python"
  printf 'VIRTUAL_ENV="%s"\nexport VIRTUAL_ENV\n' "$activates_to" >"$venv/bin/activate"
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

# Two concurrent deploys that ran preparation under different TMPDIR values
# (/tmp vs the documented Linux /var/tmp) once used separate TMPDIR-scoped
# registries and both received base port 56000 (2026-10-20). The default
# registry is per repository, and earlier TMPDIR-scoped claims stay reserved.
deploy_tmp_a="$TMP_ROOT/descend-I99-tmp-a"
deploy_tmp_b="$TMP_ROOT/descend-I99-tmp-b"
git -C "$controller" worktree add -q -b deploy-tmp-a "$deploy_tmp_a"
git -C "$controller" worktree add -q -b deploy-tmp-b "$deploy_tmp_b"
mkdir -p "$TMP_ROOT/tmpdir-a" "$TMP_ROOT/tmpdir-b"
# Earlier-protocol registries are fixtures here; never mirror into the host's.
mkdir -p "$TMP_ROOT/tmpdir-a/legacy" "$TMP_ROOT/tmpdir-b/legacy"
export ROSE_DEPLOY_LEGACY_PORT_REGISTRIES="$TMP_ROOT/tmpdir-a/legacy:$TMP_ROOT/tmpdir-b/legacy"
TMPDIR="$TMP_ROOT/tmpdir-a" bash "$PREFLIGHT" --worktree "$deploy_tmp_a" --source "$controller" \
  --skip-dependencies --skip-database >/dev/null
TMPDIR="$TMP_ROOT/tmpdir-b" bash "$PREFLIGHT" --worktree "$deploy_tmp_b" --source "$controller" \
  --skip-dependencies --skip-database >/dev/null
tmp_a_port="$(sed -nE 's/^export CONDUCTOR_PORT=([0-9]+)$/\1/p' "$deploy_tmp_a/.context/deploy-worktree.env")"
tmp_b_port="$(sed -nE 's/^export CONDUCTOR_PORT=([0-9]+)$/\1/p' "$deploy_tmp_b/.context/deploy-worktree.env")"
[ -n "$tmp_a_port" ] && [ "$tmp_a_port" != "$tmp_b_port" ] \
  || fail "deploys prepared under different TMPDIR values must receive distinct ports ($tmp_a_port/$tmp_b_port)"
[ -f "$(git -C "$controller" rev-parse --path-format=absolute --git-common-dir)/rose-deploy-worktree-ports/$tmp_a_port.json" ] \
  || fail "the default port registry must live in the repository's git common directory"
echo "PASS: deploys prepared under different TMPDIR values receive distinct ports"

foreign_repo="$TMP_ROOT/foreign-repo"
git init -q "$foreign_repo"
GIT_DIR="$foreign_repo/.git" GIT_COMMON_DIR="$foreign_repo/.git" bash "$PREFLIGHT" \
  --worktree "$deploy_tmp_b" --source "$controller" --skip-dependencies --skip-database >/dev/null
expect_eq "$(sed -nE 's/^export CONDUCTOR_PORT=([0-9]+)$/\1/p' "$deploy_tmp_b/.context/deploy-worktree.env")" "$tmp_b_port" \
  "inherited GIT_DIR/GIT_COMMON_DIR cannot redirect the port registry"
[ ! -e "$foreign_repo/.git/rose-deploy-worktree-ports" ] \
  || fail "an inherited foreign GIT_DIR must not receive this repository's port claims"

legacy_registry="$TMP_ROOT/legacy-ports"
fresh_registry="$TMP_ROOT/fresh-ports"
mkdir -p "$legacy_registry"
printf '{"base_port": 56000, "owner": "%s", "schema_version": 1}\n' "$deploy_tmp_a" >"$legacy_registry/56000.json"
respected_port="$(python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim --registry "$fresh_registry" \
  --owner "$deploy_tmp_b" --respect-registry "$legacy_registry")"
[ "$respected_port" != 56000 ] || fail "a live claim in a respected legacy registry must reserve its range"
grep -q "\"owner\": \"$deploy_tmp_a\"" "$legacy_registry/56000.json" \
  || fail "a respected legacy claim must stay with its owner"
grep -q "\"owner\": \"$deploy_tmp_b\"" "$legacy_registry/$respected_port.json" \
  || fail "a new claim must be mirrored into the legacy registry so earlier-protocol claimants observe it"
echo "PASS: a live legacy-registry claim reserves its range and new claims are mirrored to it"

# The same legacy registry named twice (directly and via a symlink) is locked
# once, and a configured but absent legacy registry is created and mirrored.
ln -s "$legacy_registry" "$TMP_ROOT/legacy-alias"
absent_registry="$TMP_ROOT/absent-legacy"
deploy_tmp_c="$TMP_ROOT/descend-I99-tmp-c"
git -C "$controller" worktree add -q -b deploy-tmp-c "$deploy_tmp_c"
alias_port="$(timeout 30 python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim --registry "$fresh_registry" \
  --owner "$deploy_tmp_c" --respect-registry "$legacy_registry" --respect-registry "$TMP_ROOT/legacy-alias" \
  --respect-registry "$absent_registry")" || fail "an aliased legacy registry must not deadlock the claim"
grep -q "\"owner\": \"$deploy_tmp_c\"" "$absent_registry/$alias_port.json" \
  || fail "an absent configured legacy registry must be created and receive the mirrored claim"
echo "PASS: aliased legacy registries lock once and absent ones are created and mirrored"

# Backend coverage shard 1 lost its listen port on 2026-10-28: the registry
# handed out 56000, inside Linux's default ephemeral range (32768-60999), so an
# outbound connection can take 56022 and make listen() hit EADDRINUSE with no
# listener present. New claims must land wholly above the live kernel window;
# a host-only ip_local_reserved_ports mitigation does not survive a reboot and
# never makes a new claim safe. A recorded claim is accepted only above the
# window or when its 101-port footprint (owned ports, the +20/+22/+24
# coverage shards and the +100 blackbox backend) is reserved; otherwise claim,
# prepare and --check fail closed without rewriting the live identity.
fake_ipv4="$TMP_ROOT/proc-sys-net-ipv4"
mkdir -p "$fake_ipv4"
printf '32768\t60999\n' >"$fake_ipv4/ip_local_port_range"
: >"$fake_ipv4/ip_local_reserved_ports"
ephemeral_registry="$TMP_ROOT/ephemeral-ports"
deploy_tmp_d="$TMP_ROOT/descend-I99-tmp-d"
git -C "$controller" worktree add -q -b deploy-tmp-d "$deploy_tmp_d"
ephemeral_safe_port="$(ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim \
  --registry "$ephemeral_registry" --owner "$deploy_tmp_d")"
[ "$ephemeral_safe_port" -gt 60999 ] \
  || fail "a deploy worktree base port must lie above the kernel ephemeral range 32768-60999 (got $ephemeral_safe_port)"
ephemeral_safe_again="$(ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim \
  --registry "$ephemeral_registry" --owner "$deploy_tmp_d")"
expect_eq "$ephemeral_safe_again" "$ephemeral_safe_port" "an ephemeral-safe claim stays idempotent"
printf '56000-56999\n' >"$fake_ipv4/ip_local_reserved_ports"
deploy_tmp_e="$TMP_ROOT/descend-I99-tmp-e"
git -C "$controller" worktree add -q -b deploy-tmp-e "$deploy_tmp_e"
reserved_port="$(ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim \
  --registry "$ephemeral_registry" --owner "$deploy_tmp_e")"
[ "$reserved_port" -gt 60999 ] \
  || fail "new claims must stay above the ephemeral range even when host ports are reserved (got $reserved_port)"
printf '32768\t60999\n' >"$fake_ipv4/ip_local_port_range"
: >"$fake_ipv4/ip_local_reserved_ports"
deploy_tmp_f="$TMP_ROOT/descend-I99-tmp-f"
git -C "$controller" worktree add -q -b deploy-tmp-f "$deploy_tmp_f"
ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" bash "$PREFLIGHT" \
  --worktree "$deploy_tmp_f" \
  --source "$controller" \
  --port-registry "$ephemeral_registry" \
  --skip-dependencies \
  --skip-database
prepared_port="$(sed -nE 's/^export CONDUCTOR_PORT=([0-9]+)$/\1/p' "$deploy_tmp_f/.context/deploy-worktree.env")"
[ -n "$prepared_port" ] && [ "$prepared_port" -gt 60999 ] \
  || fail "prepare-deploy-worktree must record an ephemeral-safe CONDUCTOR_PORT (got '$prepared_port')"
echo "PASS: deploy worktree port claims land above the kernel ephemeral range despite host mitigation"

# There must be no warning-and-continue fallback when every candidate overlaps
# the kernel window. Refuse before publishing an unusable workspace identity.
printf '1024\t65535\n' >"$fake_ipv4/ip_local_port_range"
: >"$fake_ipv4/ip_local_reserved_ports"
exhausted_registry="$TMP_ROOT/exhausted-ports"
set +e
exhausted_output="$(ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" bash "$PREFLIGHT" \
  --worktree "$deploy_tmp_f" --source "$controller" \
  --port-registry "$exhausted_registry" --skip-dependencies --skip-database 2>&1)"
exhausted_status=$?
set -e
[ "$exhausted_status" -ne 0 ] || fail "exhausted safe port ranges must fail closed"
[[ "$exhausted_output" == *"ephemeral"* && "$exhausted_output" == *"ip_local_port_range"* && "$exhausted_output" != *"then reserve"* ]] \
  || fail "safe port exhaustion must explain the kernel conflict and point at the kernel window, not at a reservation new claims ignore (got '$exhausted_output')"
expect_eq "$(sed -nE 's/^export CONDUCTOR_PORT=([0-9]+)$/\1/p' "$deploy_tmp_f/.context/deploy-worktree.env")" \
  "$prepared_port" "safe port exhaustion preserves the existing worktree identity"
[ -z "$(find "$exhausted_registry" -name '*.json' -print)" ] \
  || fail "safe port exhaustion must not publish an unsafe claim"
deploy_tmp_g="$TMP_ROOT/descend-I99-tmp-g"
git -C "$controller" worktree add -q -b deploy-tmp-g "$deploy_tmp_g"
! ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim \
  --registry "$ephemeral_registry" --owner "$deploy_tmp_g" >/dev/null 2>&1 \
  || fail "a direct claim with no range above the kernel ephemeral window must fail"
! grep -rqF "\"owner\": \"$deploy_tmp_g\"" "$ephemeral_registry" \
  || fail "a failed claim must not record a stealable range"
echo "PASS: safe port exhaustion fails without publishing an unsafe claim"

# A kernel-range change must not silently migrate or accept an existing claim:
# an unreserved one fails closed (claim, prepare) without touching the config,
# a ten-port reservation is not enough (coverage shards listen at +22/+24,
# the blackbox backend at +100), and a reservation covering the 101-port
# footprint keeps the live identity.
config_before="$(cksum <"$deploy_tmp_f/.context/deploy-worktree.env")"
set +e
existing_output="$(ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" bash "$PREFLIGHT" \
  --worktree "$deploy_tmp_f" --source "$controller" \
  --port-registry "$ephemeral_registry" --skip-dependencies --skip-database 2>&1)"
existing_status=$?
set -e
[ "$existing_status" -ne 0 ] || fail "an existing unreserved ephemeral claim must fail closed"
[[ "$existing_output" == *"ephemeral"* && "$existing_output" == *"not all reserved"* ]] \
  || fail "an unsafe existing claim must explain the kernel conflict (got '$existing_output')"
expect_eq "$(cksum <"$deploy_tmp_f/.context/deploy-worktree.env")" "$config_before" \
  "an unsafe existing claim is rejected without rewriting the live identity"
! ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim \
  --registry "$ephemeral_registry" --owner "$deploy_tmp_e" >/dev/null 2>&1 \
  || fail "a direct re-claim of an unreserved ephemeral range must fail closed"
printf '%s-%s\n' "$prepared_port" "$((prepared_port + 9))" >"$fake_ipv4/ip_local_reserved_ports"
! ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" bash "$PREFLIGHT" \
  --worktree "$deploy_tmp_f" --source "$controller" \
  --port-registry "$ephemeral_registry" --skip-dependencies --skip-database >/dev/null 2>&1 \
  || fail "a ten-port reservation must not satisfy the 101-port listen footprint"
printf '%s-%s,%s-%s\n' "$prepared_port" "$((prepared_port + 100))" "$reserved_port" "$((reserved_port + 100))" \
  >"$fake_ipv4/ip_local_reserved_ports"
ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" bash "$PREFLIGHT" \
  --worktree "$deploy_tmp_f" --source "$controller" \
  --port-registry "$ephemeral_registry" --skip-dependencies --skip-database >/dev/null
expect_eq "$(cksum <"$deploy_tmp_f/.context/deploy-worktree.env")" "$config_before" \
  "an existing fully reserved claim retains its live identity"
expect_eq "$(ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim \
  --registry "$ephemeral_registry" --owner "$deploy_tmp_e")" "$reserved_port" \
  "a direct re-claim of a fully reserved range stays idempotent"
printf '32768\t60999\n' >"$fake_ipv4/ip_local_port_range"
: >"$fake_ipv4/ip_local_reserved_ports"

# An unreadable, malformed, reversed or missing kernel range fails closed on
# Linux (and under a configured fixture tree); only a platform without the
# sysctl tree at all (macOS, no fixture) applies no exclusion.
printf 'invalid\n' >"$fake_ipv4/ip_local_port_range"
set +e
malformed_output="$(ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim \
  --registry "$ephemeral_registry" --owner "$deploy_tmp_d" 2>&1)"
malformed_status=$?
set -e
[ "$malformed_status" -ne 0 ] || fail "a malformed ip_local_port_range must fail the claim closed (got '$malformed_output')"
[[ "$malformed_output" == *"ip_local_port_range"* ]] || fail "the malformed-range failure must name ip_local_port_range"
! ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" check --base-port 61000 >/dev/null 2>&1 \
  || fail "a malformed ip_local_port_range must fail check closed"
printf '60999\t32768\n' >"$fake_ipv4/ip_local_port_range"
! ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim \
  --registry "$ephemeral_registry" --owner "$deploy_tmp_d" >/dev/null 2>&1 \
  || fail "a reversed ip_local_port_range must fail the claim closed"
! ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" check --base-port 61000 >/dev/null 2>&1 \
  || fail "a reversed ip_local_port_range must fail check closed"
printf '32768\t60999\n' >"$fake_ipv4/ip_local_port_range"
set +e
missing_output="$(ROSE_DEPLOY_PROC_SYS_NET_IPV4="$TMP_ROOT/no-such-sysctl-tree" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim \
  --registry "$ephemeral_registry" --owner "$deploy_tmp_d" 2>&1)"
missing_status=$?
set -e
[ "$missing_status" -ne 0 ] || fail "a missing kernel sysctl tree must fail the claim closed (got '$missing_output')"
[[ "$missing_output" == *"no-such-sysctl-tree"* ]] || fail "the missing-tree failure must name the missing path"
! ROSE_DEPLOY_PROC_SYS_NET_IPV4="$TMP_ROOT/no-such-sysctl-tree" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" check --base-port 61000 >/dev/null 2>&1 \
  || fail "a missing kernel sysctl tree must fail check closed"
echo "PASS: malformed, reversed and missing kernel ranges fail closed"

# A new claim must clear the window with its whole listen footprint: with the
# kernel window ending at 64025, base 64000 would put the coverage shards
# (64022/64024) back inside it, so the first eligible base is 64030.
printf '64015\t64025\n' >"$fake_ipv4/ip_local_port_range"
: >"$fake_ipv4/ip_local_reserved_ports"
boundary_registry="$TMP_ROOT/boundary-ports"
boundary_port="$(ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" claim \
  --registry "$boundary_registry" --owner "$deploy_tmp_g")"
[ "$boundary_port" -ge 64030 ] \
  || fail "a new claim must keep its +22/+24 coverage ports above the kernel window (got $boundary_port with window 64015-64025)"
printf '32768\t60999\n' >"$fake_ipv4/ip_local_port_range"
echo "PASS: new claims keep their coverage-shard footprint above the kernel window"

# `check` is the deploy preflight's verdict for a recorded base port.
: >"$fake_ipv4/ip_local_reserved_ports"
! ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" check --base-port 56000 >/dev/null 2>&1 \
  || fail "check must reject an unreserved base port inside the kernel ephemeral range"
ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" check --base-port 61000 >/dev/null \
  || fail "check must accept a base port above the kernel ephemeral range"
printf '56000-56009\n' >"$fake_ipv4/ip_local_reserved_ports"
! ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" check --base-port 56000 >/dev/null 2>&1 \
  || fail "check must reject a reservation that leaves the +20/+22/+24 coverage ports exposed"
printf '56000-56029\n' >"$fake_ipv4/ip_local_reserved_ports"
! ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" check --base-port 56000 >/dev/null 2>&1 \
  || fail "check must reject a reservation that leaves the +100 blackbox backend port exposed"
printf '56000-56999\n' >"$fake_ipv4/ip_local_reserved_ports"
ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" python3 "$ROOT_DIR/scripts/deploy-worktree-port.py" check --base-port 56000 >/dev/null \
  || fail "check must accept a base port whose footprint the host reserved"
: >"$fake_ipv4/ip_local_reserved_ports"
echo "PASS: check judges recorded ports against the kernel window and the reserved footprint"

mkdir -p "$deploy_one/node_modules"
write_fake_venv "$deploy_one/agents/venv"
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

# The deploy check gate (deploy Step 0i) refuses a recorded base port that the
# kernel may hand to outbound connections (inside the live window, footprint
# unreserved) and passes once the host reserves that footprint.
deploy_one_base="$(sed -nE 's/^export CONDUCTOR_PORT=([0-9]+)$/\1/p' "$deploy_one/.context/deploy-worktree.env")"
[ -n "$deploy_one_base" ] || fail "prepared worktree must record CONDUCTOR_PORT"
printf '1024\t65535\n' >"$fake_ipv4/ip_local_port_range"
: >"$fake_ipv4/ip_local_reserved_ports"
set +e
exposed_output="$(
  cd "$deploy_one"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" \
    CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash "$PREFLIGHT" --check 2>&1
)"
exposed_status=$?
set -e
[ "$exposed_status" -ne 0 ] \
  || fail "preflight check must fail when the owned port range is inside the kernel ephemeral range and unreserved"
[[ "$exposed_output" == *"ephemeral"* && "$exposed_output" == *"ip_local_reserved_ports"* ]] \
  || fail "exposed-port check failure must name the ephemeral range and the reservation remedy (got '$exposed_output')"
printf '%s-%s\n' "$deploy_one_base" "$((deploy_one_base + 9))" >"$fake_ipv4/ip_local_reserved_ports"
! (
  cd "$deploy_one"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" \
    CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash "$PREFLIGHT" --check
) >/dev/null 2>&1 || fail "preflight check must still fail when only the ten owned ports are reserved"
printf '%s-%s\n' "$deploy_one_base" "$((deploy_one_base + 100))" >"$fake_ipv4/ip_local_reserved_ports"
(
  cd "$deploy_one"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" ROSE_DEPLOY_PROC_SYS_NET_IPV4="$fake_ipv4" \
    CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash "$PREFLIGHT" --check
) >/dev/null || fail "preflight check must pass once the host reserved the owned footprint"
printf '32768\t60999\n' >"$fake_ipv4/ip_local_port_range"
: >"$fake_ipv4/ip_local_reserved_ports"
echo "PASS: deploy preflight check refuses an unreserved base port inside the kernel ephemeral range"

# A venv copied from the controller still activates the controller's path.
write_fake_venv "$controller/agents/venv"
write_fake_venv "$deploy_one/agents/venv" "$controller/agents/venv"
set +e
copied_venv_output="$(
  cd "$deploy_one"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
    CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash "$PREFLIGHT" --check 2>&1
)"
copied_venv_status=$?
set -e
[ "$copied_venv_status" -ne 0 ] || fail "preflight check must reject a venv that activates another checkout"
[[ "$copied_venv_output" == *"activates another checkout's environment"* ]] || fail "copied venv failure must name the foreign activation"
write_fake_venv "$deploy_one/agents/venv"
(
  cd "$deploy_one"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" \
    CONDUCTOR_PORT=55040 CONDUCTOR_WORKSPACE_PATH="$controller" \
    bash "$PREFLIGHT" --check
) >/dev/null
echo "PASS: a venv copied from another checkout fails the deploy preflight"

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
mkdir -p "$deploy_system/node_modules"
write_fake_venv "$deploy_system/agents/venv"
cat >"$fake_bin/pg_isready" <<'PG_ISREADY'
#!/usr/bin/env bash
exit 0
PG_ISREADY
cat >"$fake_bin/psql" <<'PSQL'
#!/usr/bin/env bash
set -euo pipefail
query="${*: -1}"
db="${query#*datname = \'}"
db="${db%%\'*}"
[ -f "${FAKE_SYSTEM_PG_STATE:?}/$db" ] && printf '1\n'
PSQL
cat >"$fake_bin/createdb" <<'CREATEDB'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${FAKE_SYSTEM_PG_STATE:?}"
touch "$FAKE_SYSTEM_PG_STATE/${*: -1}"
CREATEDB
chmod +x "$fake_bin/pg_isready" "$fake_bin/psql" "$fake_bin/createdb"
fake_system_pg_state="$TMP_ROOT/system-pg"
ROSE_USE_SYSTEM_PG=true PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" FAKE_SYSTEM_PG_STATE="$fake_system_pg_state" \
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
grep -Eq '^export ROSE_USE_SYSTEM_PG=true[[:space:]]*$' \
  "$deploy_system/.context/deploy-worktree.env" \
  || fail "system Postgres prepare must persist ROSE_USE_SYSTEM_PG into deploy-worktree.env"
expect_eq "$(cat "$deploy_system/.context/deploy-system-pg.db")" "$system_db" \
  "system Postgres prepare writes the isolated database marker"
PATH="$fake_bin:$PATH" FAKE_SYSTEM_PG_STATE="$fake_system_pg_state" PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$system_db'" | grep -q '^1$' \
  || fail "system Postgres prepare must create the isolated database"
# Clean-shell --check: only the persisted env file, no ambient ROSE_USE_SYSTEM_PG.
env -u ROSE_USE_SYSTEM_PG \
  PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" FAKE_SYSTEM_PG_STATE="$fake_system_pg_state" \
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
    PATH="$fake_bin:$PATH" FAKE_DOCKER_STATE="$fake_docker_state" FAKE_SYSTEM_PG_STATE="$fake_system_pg_state" \
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

# Cloud dev boxes: the primary checkout carries a self-rooted .cloud-env and no
# Conductor-provided CONDUCTOR_WORKSPACE_PATH.
write_cloud_env_fixture() {
  printf '# rose-cloud-env\nexport CONDUCTOR_PORT=3001\nexport CONDUCTOR_WORKSPACE_NAME=cloud-fixture\nexport CONDUCTOR_ROOT_PATH=%s\n' \
    "$2" >"$1/.cloud-env"
}
write_cloud_env_fixture "$controller" "$controller"
cloud_primary_output="$(
  cd "$controller"
  env -u CONDUCTOR_WORKSPACE_PATH bash "$PREFLIGHT" --check 2>&1
)" || fail "primary cloud workspace --check must pass without deploy-worktree.env"
[[ "$cloud_primary_output" == *"Primary cloud workspace"* ]] \
  || fail "primary cloud workspace pass must be explicit"
echo "PASS: primary cloud workspace passes the deploy preflight"

cloud_linked="$TMP_ROOT/cloud-linked"
git -C "$controller" worktree add -q -b cloud-linked "$cloud_linked"
cloud_linked="$(cd "$cloud_linked" && pwd -P)"
for cloud_root in "$cloud_linked" "$controller"; do
  write_cloud_env_fixture "$cloud_linked" "$cloud_root"
  set +e
  cloud_linked_output="$(
    cd "$cloud_linked"
    env -u CONDUCTOR_WORKSPACE_PATH bash "$PREFLIGHT" --check 2>&1
  )"
  cloud_linked_status=$?
  set -e
  [ "$cloud_linked_status" -ne 0 ] \
    || fail "linked worktree with .cloud-env rooted at $cloud_root must still require isolated preparation"
  [[ "$cloud_linked_output" == *"missing .context/deploy-worktree.env"* ]] \
    || fail "linked cloud worktree failure must name the missing preparation"
done
echo "PASS: a copied .cloud-env cannot make a linked worktree pass as primary"

# A linked worktree with no .cloud-env at all must fail with the actionable
# message, not die silently under pipefail (exit 2, no output).
rm -f "$cloud_linked/.cloud-env"
set +e
no_cloud_env_output="$(
  cd "$cloud_linked"
  env -u CONDUCTOR_WORKSPACE_PATH bash "$PREFLIGHT" --check 2>&1
)"
no_cloud_env_status=$?
set -e
[ "$no_cloud_env_status" -eq 1 ] \
  || fail "linked worktree without .cloud-env must exit 1, got $no_cloud_env_status"
[[ "$no_cloud_env_output" == *"missing .context/deploy-worktree.env"* ]] \
  || fail "linked worktree without .cloud-env must name the missing preparation"
echo "PASS: a linked worktree without .cloud-env fails with the preparation message"

# Root dependency install: no root lockfile is committed, so a fresh root
# `npm install` re-resolves the live registry (npm 10.9's arborist crashed on
# that graph on 2026-10-12). Preparation seeds the worktree lockfile from the
# source workspace's recorded installation only when the manifests match.
SEED_LOCKFILE="$ROOT_DIR/scripts/lib/seed_root_npm_lockfile.py"
seed_line="$(grep -n 'seed_root_npm_lockfile.py' "$PREFLIGHT" | head -n 1 | cut -d: -f1)"
install_line="$(grep -n 'npm install --no-audit --no-fund$' "$PREFLIGHT" | head -n 1 | cut -d: -f1)"
[ -n "$seed_line" ] && [ -n "$install_line" ] && [ "$seed_line" -lt "$install_line" ] \
  || fail "root dependency install must seed the source workspace's resolved tree before npm install"
echo "PASS: root dependency install seeds the source lockfile before npm install"

seed_source="$TMP_ROOT/seed-source"
seed_target="$TMP_ROOT/seed-target"
write_seed_manifests() {
  local root="$1"
  local backend_zod="$2"
  mkdir -p "$root/back-end" "$root/front-end"
  printf '%s\n' '{"name":"fixture-root","version":"1.0.1","scripts":{"prepare":"true"},"workspaces":["back-end","front-end"],"devDependencies":{"husky":"^9.0.11"}}' \
    >"$root/package.json"
  printf '{"name":"fixture-backend","version":"1.0.0","dependencies":{"zod":"%s"}}\n' "$backend_zod" \
    >"$root/back-end/package.json"
  printf '%s\n' '{"name":"fixture-frontend","version":"0.0.0","devDependencies":{"vite":"^5.0.0"}}' \
    >"$root/front-end/package.json"
}
write_seed_manifests "$seed_source" "3.25.67"
mkdir -p "$seed_source/node_modules"
printf '%s\n' '{"name":"fixture-root","version":"1.0.1","lockfileVersion":3,"requires":true,"packages":{"back-end":{"name":"fixture-backend","version":"1.0.0","dependencies":{"zod":"3.25.67"}},"front-end":{"name":"fixture-frontend","version":"0.0.0","devDependencies":{"vite":"^5.0.0"}},"node_modules/fixture-backend":{"resolved":"back-end","link":true},"node_modules/zod":{"version":"3.25.67","resolved":"https://registry.npmjs.org/zod/-/zod-3.25.67.tgz"}}}' \
  >"$seed_source/node_modules/.package-lock.json"
source_hidden_before="$(cksum <"$seed_source/node_modules/.package-lock.json")"
write_seed_manifests "$seed_target" "3.25.67"

seed_output="$(python3 "$SEED_LOCKFILE" "$seed_target" "$seed_source")" \
  || fail "seeding a matching worktree must succeed"
[[ "$seed_output" == *"reused the source workspace's verified npm tree"* ]] \
  || fail "seeding a matching worktree must report the reused tree"
[ -f "$seed_target/package-lock.json" ] || fail "matching manifests must produce a root lockfile"
python3 - "$seed_target/package-lock.json" <<'PY' || fail "seeded root lockfile must carry the source tree and the worktree root entry"
import json
import sys

lock = json.load(open(sys.argv[1]))
packages = lock["packages"]
assert lock["lockfileVersion"] == 3, lock
assert packages["node_modules/zod"]["version"] == "3.25.67", packages
assert packages["node_modules/fixture-backend"] == {"resolved": "back-end", "link": True}, packages
root = packages[""]
assert root["name"] == "fixture-root", root
assert root["workspaces"] == ["back-end", "front-end"], root
assert root["devDependencies"] == {"husky": "^9.0.11"}, root
assert root["hasInstallScript"] is True, root
PY
expect_eq "$(cksum <"$seed_source/node_modules/.package-lock.json")" "$source_hidden_before" \
  "seeding never modifies the source workspace installation record"

seeded_before="$(cksum <"$seed_target/package-lock.json")"
seed_output="$(python3 "$SEED_LOCKFILE" "$seed_target" "$seed_source")" \
  || fail "seeding with an existing root lockfile must be a no-op"
[[ "$seed_output" == *"already has a root package-lock.json"* ]] \
  || fail "an existing worktree lockfile must be reported and preserved"
expect_eq "$(cksum <"$seed_target/package-lock.json")" "$seeded_before" \
  "an existing worktree root lockfile is never replaced"

rm -f "$seed_target/package-lock.json"
write_seed_manifests "$seed_target" "3.25.76"
seed_output="$(python3 "$SEED_LOCKFILE" "$seed_target" "$seed_source")" \
  || fail "a workspace dependency mismatch must fall back without failing"
[[ "$seed_output" == *"back-end dependencies differ"* ]] \
  || fail "a workspace dependency mismatch must name the differing workspace"
[ ! -e "$seed_target/package-lock.json" ] \
  || fail "a workspace dependency mismatch must leave ordinary resolution untouched"
echo "PASS: a workspace dependency mismatch never reuses the source tree"

write_seed_manifests "$seed_target" "3.25.67"
printf '%s\n' '{"name":"fixture-root","version":"1.0.2","workspaces":["back-end","front-end"]}' \
  >"$seed_target/package.json"
seed_output="$(python3 "$SEED_LOCKFILE" "$seed_target" "$seed_source")" \
  || fail "a root manifest mismatch must fall back without failing"
[[ "$seed_output" == *"root package.json differs"* ]] \
  || fail "a root manifest mismatch must be reported"
[ ! -e "$seed_target/package-lock.json" ] \
  || fail "a root manifest mismatch must leave ordinary resolution untouched"
echo "PASS: a root manifest mismatch never reuses the source tree"

write_seed_manifests "$seed_target" "3.25.67"
rm -f "$seed_source/node_modules/.package-lock.json"
seed_output="$(python3 "$SEED_LOCKFILE" "$seed_target" "$seed_source")" \
  || fail "a source without a recorded installation must fall back without failing"
[[ "$seed_output" == *"no recorded npm installation"* ]] \
  || fail "a source without a recorded installation must be reported"
[ ! -e "$seed_target/package-lock.json" ] \
  || fail "a source without a recorded installation must leave ordinary resolution untouched"
echo "PASS: a source without a recorded installation falls back to ordinary resolution"

echo "All deploy-worktree preflight tests passed."
