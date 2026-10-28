# Rose project sync script (Template sync, the equivalent of a boxes.dev Template
# box's maintenance script). Rose runs it on the project's ONE template sandbox
# on triggers (nightly, GitHub default-branch change, Run now); when it succeeds
# Rose snapshots the sandbox and new code sessions start from that snapshot with
# dependencies already installed (see rose-startup.sh for the per-session part).
#
# Incremental: a run starts from the previous snapshot, so only what changed is
# installed. Runs in the checkout (ROSE_PROJECT_DIR) with a token-bearing origin;
# Rose scrubs credentials before it snapshots. Exit non-zero = no snapshot.
set -euo pipefail
cd "${ROSE_PROJECT_DIR:-.}"
BRANCH="${ROSE_DEFAULT_BRANCH:-main}"

git fetch --quiet origin "$BRANCH" && git checkout --quiet "$BRANCH" && git merge --ff-only --quiet "origin/$BRANCH"

# Stamps shared with rose-startup.sh (same hash definitions): a session that starts
# from this snapshot sees them and skips every install.
SWAP_ADDED=0
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
    echo "[rose-sync] added 3 GB swap (this sandbox has ${mem} MB RAM)"
  else
    echo "[rose-sync] warning: could not add swap; a dependency install may be OOM-killed"
  fi
}
# The snapshot every session starts from must not carry the swapfile.
trap '[ "$SWAP_ADDED" = 1 ] && { sudo -n swapoff /swapfile; sudo -n rm -f /swapfile; }; true' EXIT

STAMP="$HOME/.cache/rose-maintenance"; mkdir -p "$STAMP"
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }

ensure_swap
js_hash=$(cat package.json {back-end,front-end}/package.json {back-end,front-end}/package-lock.json | sha)
if [ "$js_hash" != "$(cat "$STAMP/js" 2>/dev/null || true)" ]; then
  npm install --include=dev --no-audit --no-fund --legacy-peer-deps
  echo "$js_hash" > "$STAMP/js"
fi
(cd back-end && npx prisma generate)
sha < back-end/prisma/schema.prisma > "$STAMP/prisma"

# The sandbox ships Python 3.10 without the venv module; uv supplies 3.11.9.
if ! { [ -x agents/venv/bin/python ] && agents/venv/bin/python scripts/lib/agents_venv_satisfied.py agents/requirements.txt; }; then
  uv="$(command -v uv || true)"
  if [ -z "$uv" ]; then
    python3 -m pip install --user --quiet --disable-pip-version-check "uv==0.12.24"
    uv="$HOME/.local/bin/uv"
  fi
  [ -x agents/venv/bin/python ] || "$uv" venv --quiet --seed --python 3.11.9 agents/venv
  (cd agents && "$uv" pip install --quiet --python venv/bin/python -r requirements.txt)
fi

(cd back-end && node --import tsx -e "require('./scripts/seed-dump-cache.ts')")
echo "[rose-sync] ready at $(git rev-parse --short HEAD)"
