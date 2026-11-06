#!/usr/bin/env bash
# Prepare a fresh Blacksmith Ubuntu 24.04 runner for one /deploy gate
# (.github/workflows/deploy-gates.yml). Mirrors the devbox toolchain: Node 22,
# Python 3.11.9 agents/venv, system PostgreSQL 16 + pgvector, Playwright Chromium,
# uv, flyctl, ruby and rsync. Private env files come from one secret bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
step() { printf '\n== %s (%ss)\n' "$1" "$SECONDS"; }
DEPS="${DEPLOY_GATE_DEPS:-/home/runner/rose-deps}"
# Dependency directories bind-mounted from the sticky disk at their devbox paths.
MOUNTS=(node_modules back-end/node_modules front-end/node_modules agents/venv)
BROWSERS="$HOME/.cache/ms-playwright"

if [ "${1:-}" = "--release" ]; then
  for target in "$BROWSERS" "${MOUNTS[@]/#/$ROOT/}"; do
    mountpoint -q "$target" && sudo umount "$target"
  done
  exit 0
fi

step "env files"
[ -n "${DEPLOY_GATE_ENV_BUNDLE:-}" ] || { echo "DEPLOY_GATE_ENV_BUNDLE secret is missing" >&2; exit 1; }
( umask 077 && printf %s "$DEPLOY_GATE_ENV_BUNDLE" | base64 -d | tar -xz -C "$ROOT" )
for f in agents/.env back-end/.env front-end/.env; do
  [ -s "$f" ] || { echo "env bundle lacks $f" >&2; exit 1; }
done

step "git identity"
git config --global user.name "Rose Deploy Gate"
git config --global user.email "deploy-gates@roselabs.ai"

step "system packages"
missing=()
command -v ruby >/dev/null || missing+=(ruby)
command -v rsync >/dev/null || missing+=(rsync)
command -v lsof >/dev/null || missing+=(lsof)
PG_MAJOR=$(ls /usr/lib/postgresql 2>/dev/null | sort -n | tail -1)
[ -n "$PG_MAJOR" ] || { PG_MAJOR=16; missing+=(postgresql-16 postgresql-client-16); }
[ -f "/usr/share/postgresql/$PG_MAJOR/extension/vector.control" ] || missing+=("postgresql-$PG_MAJOR-pgvector")
if [ ${#missing[@]} -gt 0 ]; then
  sudo apt-get install -y -qq "${missing[@]}" >/dev/null 2>&1 \
    || { sudo apt-get update -qq >/dev/null && sudo apt-get install -y -qq "${missing[@]}" >/dev/null; }
fi

step "postgres $PG_MAJOR"
sudo systemctl start postgresql 2>/dev/null || sudo service postgresql start
for _ in $(seq 1 30); do pg_isready -h localhost -q && break; sleep 1; done
sudo -u postgres psql -q -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres createdb victoria 2>/dev/null || true

step "flyctl"
for attempt in 1 2 3; do
  command -v flyctl >/dev/null || [ -x "$HOME/.fly/bin/flyctl" ] && break
  curl -fsSL --retry 3 https://fly.io/install.sh | sh >/dev/null || { echo "flyctl install attempt $attempt failed" >&2; sleep 5; }
done
[ -x "$HOME/.fly/bin/flyctl" ] || command -v flyctl >/dev/null || { echo "flyctl unavailable" >&2; exit 1; }
echo "$HOME/.fly/bin" >> "$GITHUB_PATH"

step "dependency disk"
sudo chown "$(id -u):$(id -g)" "$DEPS"
for rel in "${MOUNTS[@]}"; do
  mkdir -p "$DEPS/$rel" "$ROOT/$rel"
  sudo mount --bind "$DEPS/$rel" "$ROOT/$rel"
done
mkdir -p "$DEPS/ms-playwright" "$BROWSERS"
sudo mount --bind "$DEPS/ms-playwright" "$BROWSERS"
echo "$ROOT/agents/venv/bin" >> "$GITHUB_PATH"
if [ -f "$DEPS/.ready" ]; then
  echo "dependency disk ready since $(cat "$DEPS/.ready")"
else
  step "node_modules"
  # The hoisted workspace install scripts/cloud-build.sh uses on every Linux box: npx/tsx/prisma
  # resolve from the root exactly as on the devbox. No root lockfile is committed (.gitignore);
  # the sticky disk pins the resolved tree until a manifest or package lockfile changes its key.
  find node_modules back-end/node_modules front-end/node_modules agents/venv -mindepth 1 -maxdepth 1 \
    -exec rm -rf {} +
  npm install --include=dev --no-audit --no-fund --legacy-peer-deps
  step "agents venv"
  python -m venv agents/venv
  uv pip install --quiet --python agents/venv/bin/python -r agents/requirements.txt
  step "playwright"
  agents/venv/bin/python -m playwright install chromium >/dev/null
  (cd front-end && npx --no-install playwright install chromium >/dev/null 2>&1) || true
  npx --no-install playwright install chromium >/dev/null 2>&1 || true
  date -u +%FT%TZ > "$DEPS/.ready"
fi

step "prisma client"
# Regenerate only when the schema differs from the disk's client, so an unchanged disk stays clean.
schema=$(sha256sum back-end/prisma/schema.prisma | cut -d' ' -f1)
if [ "$(cat "$DEPS/.prisma-schema" 2>/dev/null)" != "$schema" ]; then
  (cd back-end && npx --no-install prisma generate >/dev/null)
  echo "$schema" > "$DEPS/.prisma-schema"
fi

step "ready"
printf 'node %s, python %s, %s, nproc %s, mem %s\n' "$(node --version)" "$(agents/venv/bin/python --version 2>&1)" \
  "$(psql --version)" "$(nproc)" "$(free -g | awk '/Mem:/{print $2 " GB"}')"
