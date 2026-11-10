# Rose project startup: runs in the checkout of EVERY code session (new or resumed
# E2B sandbox, local session, boxes devbox) before the agent, so it must stay fast.
#
# A session that starts from the project's template snapshot (built by
# rose-sync.sh) already has node_modules, the Prisma client and agents/venv: the
# readiness check below passes and the whole script takes seconds. Otherwise
# (no snapshot yet, or main moved a lockfile/schema since it) the stamp-guarded
# install runs as the fallback, with JS and Python in parallel.
#
#   1. re-key .cloud-env (boxes snapshot identity)
#   2. start local Postgres when it is installed
#   3. dependencies: skip when the stamps match, else install what is stale
#
# A dependency tree that is a symlink (a shared checkout's install) is only
# checked, never modified. Exits non-zero when a step failed; the startup report
# carries the output tail to the agent.
set -u
ROSE_STARTUP_BEGIN=$SECONDS
ROSE_PY_VERSION=3.11.9
ROSE_UV_VERSION=0.12.24
# Same stamps and hash definitions as rose-sync.sh.
ROSE_STATE="$HOME/.cache/rose-maintenance"
ROSE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/rose-startup.XXXXXX")"
trap 'rm -rf "$ROSE_TMP"' EXIT

say() { printf '[rose-startup] %s\n' "$*"; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }

# Mint a fresh workspace identity for this devbox. The snapshot carries the
# Template box's .cloud-env, and scripts/run.sh derives the Temporal task
# queue and ngrok domain from it; devboxes must never share those. On Linux a
# missing file is created (a session from the base template has none) and, when
# system Postgres is installed, selects it: Docker is not used on sandboxes.
# Other platforms only re-key a file that already exists.
if [ -f scripts/lib/workspace-env.sh ] && { [ -f .cloud-env ] || [ "$(uname -s)" = Linux ]; }; then
bash -s <<'REKEY' || echo "warning: could not re-key .cloud-env; scripts/run.sh re-keys it on a new boot"
set -eu
. scripts/lib/workspace-env.sh
port="$(cloud_env_value .cloud-env CONDUCTOR_PORT 2>/dev/null || true)"
write_cloud_env .cloud-env "${port:-3001}" "$(new_cloud_workspace_name)" "$PWD" "$(cloud_env_boot_id)" "$(cloud_env_agent_id)"
if command -v pg_ctlcluster >/dev/null 2>&1; then echo 'export ROSE_USE_SYSTEM_PG=true' >>.cloud-env; fi
REKEY
fi

# Local Postgres backs the stack and the test suites; never restarted here.
PG_UP=0
if command -v pg_ctlcluster >/dev/null 2>&1 || [ -x /etc/init.d/postgresql ]; then
  sudo -n service postgresql start >/dev/null 2>&1 || say "warning: could not start Postgres"
  if command -v pg_isready >/dev/null 2>&1; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pg_isready -q -h localhost 2>/dev/null && { PG_UP=1; break; }
      sleep 1
    done
    [ "$PG_UP" = 1 ] || say "warning: Postgres is not accepting connections"
  fi
else
  say "note: PostgreSQL is not installed here; database-backed tests are unavailable"
fi

# The default E2B sandbox has ~1 GB RAM and an npm install of this repo is OOM-killed
# there (measured 2026-10-28). Add a swapfile when memory is small and none exists.
ensure_swap() {
  local meminfo="${ROSE_MEMINFO:-/proc/meminfo}" mem swap
  mem=$(awk '/^MemTotal:/ {print int($2/1024)}' "$meminfo" 2>/dev/null || true)
  swap=$(awk '/^SwapTotal:/ {print $2}' "$meminfo" 2>/dev/null || true)
  [ -n "$mem" ] && [ "$mem" -lt 3500 ] && [ "${swap:-0}" = 0 ] || return 0
  if sudo -n fallocate -l 3G /swapfile && sudo -n chmod 600 /swapfile \
    && sudo -n mkswap /swapfile >/dev/null && sudo -n swapon /swapfile; then
    SWAP_ADDED=1
    export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=900"
    echo "[rose-startup] added 3 GB swap (this sandbox has ${mem} MB RAM)"
  else
    echo "[rose-startup] warning: could not add swap; a dependency install may be OOM-killed"
  fi
}

# Same definition as rose-sync.sh: native addons are built per Node ABI, so the
# Node major is part of the stamp.
js_hash() {
  local base
  base="$(cat package.json back-end/package.json front-end/package.json back-end/package-lock.json front-end/package-lock.json 2>/dev/null | sha)"
  printf '%s\nnode%s\n' "$base" "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" | sha
}

js_ready() { [ -x node_modules/.bin/tsx ] || [ -x back-end/node_modules/.bin/tsx ]; }

prisma_ready() {
  [ -f node_modules/.prisma/client/index.js ] || [ -f back-end/node_modules/.prisma/client/index.js ]
}

js_deps() {
  local began=$SECONDS want installed=0
  want="$(js_hash)"
  if [ -L node_modules ]; then
    js_ready || { say "js: node_modules links to a shared install without tsx; not modifying it"; return 1; }
    say "js: node_modules links to a shared install; left as is"
  elif js_ready && [ "$(cat "$ROSE_STATE/js" 2>/dev/null)" = "$want" ]; then
    say "js: dependencies unchanged; skipped"
  else
    say "js: npm install (root + workspaces)..."
    ensure_swap
    # --legacy-peer-deps: npm 10.9 arborist crashes on this tree's vitest peers
    # otherwise (same flags as scripts/cloud-build.sh and the Template box).
    npm install --include=dev --no-audit --no-fund --legacy-peer-deps || return 1
    mkdir -p "$ROSE_STATE" && printf '%s\n' "$want" >"$ROSE_STATE/js"
    installed=1
    say "js: installed in $((SECONDS - began))s"
  fi
  want="$(sha <back-end/prisma/schema.prisma)"
  if [ -L node_modules ]; then
    prisma_ready || { say "prisma: shared install has no Prisma client; not modifying it"; return 1; }
    say "prisma: shared client present; left as is"
  elif [ "$installed" = 0 ] && prisma_ready && [ "$(cat "$ROSE_STATE/prisma" 2>/dev/null)" = "$want" ]; then
    say "prisma: client up to date; skipped"
  else
    say "prisma: generating client..."
    (cd back-end && npx --no-install prisma generate) || return 1
    mkdir -p "$ROSE_STATE" && printf '%s\n' "$want" >"$ROSE_STATE/prisma"
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

reference_metadata() {
  local dir repair=0 saved=0 rc=0 record=prompt-review/REF_SHAS.txt
  # Old snapshots stripped .git from reference sources. Repair existing trees;
  # a session without reference sources has no metadata to migrate.
  for dir in openclaw hermes-agent codex prime-agent kimi-code; do
    if [ -d "$dir" ] && [ ! -e "$dir/.git" ]; then repair=1; break; fi
  done
  [ "$repair" = 1 ] || return 0
  say "refs: restoring reference git metadata..."
  if [ -f "$record" ]; then
    cp -p "$record" "$ROSE_TMP/ref-record" || return 1
    saved=1
  fi
  bash scripts/sync-reference-repos.sh || rc=$?
  # The source pins are unchanged; keep the caller's exact tracked tip record.
  if [ "$saved" = 1 ]; then cp -p "$ROSE_TMP/ref-record" "$record" || return 1; fi
  return "$rc"
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
step refs reference_metadata &
wait

failed=""
for name in js py refs; do
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

# The snapshot's local `victoria` follows the schema it was synced at; main may have
# moved schema.prisma since. Push only the delta (local-only, refuses non-localhost).
LOCAL_DB=postgresql://postgres:postgres@localhost:5432/victoria
case " $failed " in
  *" js "*) ;;
  *)
    if [ "$PG_UP" = 1 ] && PGPASSWORD=postgres psql -h localhost -U postgres -d victoria -tAc 'select 1' >/dev/null 2>&1; then
      want="$(sha <back-end/prisma/schema.prisma)"
      if [ "$(cat "$ROSE_STATE/dbschema" 2>/dev/null)" = "$want" ]; then
        say "db: schema unchanged; skipped"
      elif (cd back-end && DATABASE_URL="$LOCAL_DB" DIRECT_URL="$LOCAL_DB" npm run prisma:push:local -- --accept-data-loss --skip-generate >/dev/null \
          && DATABASE_URL="$LOCAL_DB" DIRECT_URL="$LOCAL_DB" LOCAL_DB_NAME=victoria bash scripts/apply-local-workflow-ddl.sh >/dev/null); then
        mkdir -p "$ROSE_STATE" && printf '%s\n' "$want" >"$ROSE_STATE/dbschema"
        say "db: schema pushed"
      else
        failed="$failed db"
      fi
    fi
    ;;
esac

if [ -n "$failed" ]; then
  say "FAILED:$failed (after $((SECONDS - ROSE_STARTUP_BEGIN))s)"
  exit 1
fi
say "ready in $((SECONDS - ROSE_STARTUP_BEGIN))s"
