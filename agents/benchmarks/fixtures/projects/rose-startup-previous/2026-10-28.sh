# Rose project startup: runs in the fresh checkout of every code session
# (new or resumed E2B sandbox, local session, boxes devbox) before the agent.
# Idempotent: each step checks first and skips when already satisfied, so a
# resumed session starts in seconds.
#
#   1. re-key .cloud-env (boxes snapshot identity)
#   2. start local Postgres when it is installed
#   3. js: root npm install when the package manifests changed  ┐ in
#          + Prisma client when schema.prisma changed            │ parallel
#   4. py: agents/venv (Python 3.11.9) when requirements.txt     │
#          is not satisfied (scripts/lib/agents_venv_satisfied.py)┘
#   5. backend import sanity check
#
# A dependency tree that is a symlink (a shared checkout's install) is only
# checked, never modified. Exits non-zero when a step failed; the startup
# report carries the output tail to the agent.
set -u
ROSE_STARTUP_BEGIN=$SECONDS
ROSE_PY_VERSION=3.11.9
ROSE_UV_VERSION=0.12.24
ROSE_STATE=node_modules/.rose-startup
ROSE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/rose-startup.XXXXXX")"
trap 'rm -rf "$ROSE_TMP"' EXIT

say() { printf '[rose-startup] %s\n' "$*"; }

# Change-detection key over files and a version (cksum is POSIX: Linux and macOS).
key_of() { cat "$@" 2>/dev/null | cksum | tr -d ' \t'; }

# Mint a fresh workspace identity for this devbox. The snapshot carries the
# Template box's .cloud-env, and scripts/run.sh derives the Temporal task
# queue and ngrok domain from it; devboxes must never share those.
if [ -f .cloud-env ] && [ -f scripts/lib/workspace-env.sh ]; then
bash -s <<'REKEY' || echo "warning: could not re-key .cloud-env; scripts/run.sh re-keys it on a new boot"
set -eu
. scripts/lib/workspace-env.sh
port="$(cloud_env_value .cloud-env CONDUCTOR_PORT)"
write_cloud_env .cloud-env "${port:-3001}" "$(new_cloud_workspace_name)" "$PWD" "$(cloud_env_boot_id)" "$(cloud_env_agent_id)"
REKEY
fi

# Local Postgres backs the stack and the test suites; never restarted here.
if command -v pg_ctlcluster >/dev/null 2>&1 || [ -x /etc/init.d/postgresql ]; then
  sudo -n service postgresql start >/dev/null 2>&1 || say "warning: could not start Postgres"
else
  say "note: PostgreSQL is not installed here; database-backed tests are unavailable"
fi

js_manifests() {
  node --version 2>/dev/null
  cat package.json back-end/package.json front-end/package.json \
    back-end/package-lock.json front-end/package-lock.json 2>/dev/null
}

js_ready() { [ -x node_modules/.bin/tsx ] || [ -x back-end/node_modules/.bin/tsx ]; }

prisma_ready() {
  [ -f node_modules/.prisma/client/index.js ] || [ -f back-end/node_modules/.prisma/client/index.js ]
}

js_deps() {
  local began=$SECONDS want
  want="$(js_manifests | cksum | tr -d ' \t')"
  if [ -L node_modules ]; then
    js_ready || { say "js: node_modules links to a shared install without tsx; not modifying it"; return 1; }
    say "js: node_modules links to a shared install; left as is"
  elif js_ready && [ "$(cat "$ROSE_STATE/js" 2>/dev/null)" = "$want" ]; then
    say "js: dependencies unchanged; skipped"
  else
    say "js: npm install (root + workspaces)..."
    # --legacy-peer-deps: npm 10.9 arborist crashes on this tree's vitest peers
    # otherwise (same flags as scripts/cloud-build.sh and the Template box).
    npm install --include=dev --no-audit --no-fund --legacy-peer-deps || return 1
    mkdir -p "$ROSE_STATE" && printf '%s\n' "$want" >"$ROSE_STATE/js"
    say "js: installed in $((SECONDS - began))s"
  fi
  want="$(key_of "$ROSE_STATE/js" back-end/prisma/schema.prisma)"
  if [ -L node_modules ]; then
    prisma_ready || { say "prisma: shared install has no Prisma client; not modifying it"; return 1; }
    say "prisma: shared client present; left as is"
  elif prisma_ready && [ "$(cat "$ROSE_STATE/prisma" 2>/dev/null)" = "$want" ]; then
    say "prisma: client up to date; skipped"
  else
    say "prisma: generating client..."
    (cd back-end && npx --no-install prisma generate) || return 1
    printf '%s\n' "$want" >"$ROSE_STATE/prisma"
  fi
  say "js: ready in $((SECONDS - began))s"
}

venv_satisfied() {
  [ -x agents/venv/bin/python ] &&
    agents/venv/bin/python scripts/lib/agents_venv_satisfied.py agents/requirements.txt 2>"$ROSE_TMP/venv-check"
}

find_uv() {
  local uv
  for uv in "$(command -v uv 2>/dev/null)" "$HOME/.local/bin/uv"; do
    [ -n "$uv" ] && [ -x "$uv" ] && { printf '%s\n' "$uv"; return 0; }
  done
  # The E2B code template ships python3 3.10 + pip but neither the venv module
  # nor Python 3.11; uv supplies both. Pinned for reproducible installs.
  python3 -m pip install --user --quiet --disable-pip-version-check "uv==$ROSE_UV_VERSION" >&2 || true
  [ -x "$HOME/.local/bin/uv" ] ||
    curl -LsSf "https://astral.sh/uv/$ROSE_UV_VERSION/install.sh" | env UV_NO_MODIFY_PATH=1 sh >&2
  [ -x "$HOME/.local/bin/uv" ] && printf '%s\n' "$HOME/.local/bin/uv"
}

py_deps() {
  local began=$SECONDS uv
  if venv_satisfied; then
    say "py: agents/venv satisfies requirements.txt; skipped"
    return 0
  fi
  [ -x agents/venv/bin/python ] && head -n 3 "$ROSE_TMP/venv-check"
  if [ -L agents/venv ]; then
    say "py: agents/venv links to a shared venv that is not satisfied; not modifying it"
    head -n 5 "$ROSE_TMP/venv-check"
    return 1
  fi
  uv="$(find_uv)" || { say "py: could not install uv"; return 1; }
  if [ ! -x agents/venv/bin/python ]; then
    say "py: creating agents/venv (Python $ROSE_PY_VERSION)..."
    "$uv" venv --quiet --seed --python "$ROSE_PY_VERSION" agents/venv || return 1
  fi
  say "py: installing agents/requirements.txt..."
  (cd agents && "$uv" pip install --quiet --python venv/bin/python -r requirements.txt) || return 1
  venv_satisfied || { head -n 5 "$ROSE_TMP/venv-check"; return 1; }
  say "py: ready in $((SECONDS - began))s"
}

# Run one step with its output line-prefixed; its status lands in $ROSE_TMP/<name>.
step() {
  local name="$1"
  shift
  { "$@"; echo "$?" >"$ROSE_TMP/$name"; } 2>&1 | while IFS= read -r line || [ -n "$line" ]; do
    printf '[%s] %s\n' "$name" "$line"
  done
}

step js js_deps &
step py py_deps &
wait

failed=""
for name in js py; do
  [ "$(cat "$ROSE_TMP/$name" 2>/dev/null)" = 0 ] || failed="$failed $name"
done

case " $failed " in
  *" js "*) say "check: skipped (JS dependencies are not ready)" ;;
  *)
    if (cd back-end && node --import tsx -e "require('./scripts/seed-dump-cache.ts')"); then
      say "check: backend seed-cache imports ready"
    else
      failed="$failed check"
    fi
    ;;
esac

if [ -n "$failed" ]; then
  say "FAILED:$failed (after $((SECONDS - ROSE_STARTUP_BEGIN))s)"
  exit 1
fi
say "ready in $((SECONDS - ROSE_STARTUP_BEGIN))s"
