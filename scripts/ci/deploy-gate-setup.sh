#!/usr/bin/env bash
# Prepare a fresh Blacksmith Ubuntu 24.04 runner for one /deploy gate
# (.github/workflows/deploy-gates.yml). Mirrors the devbox toolchain: Node 22,
# uv-managed Python 3.11.9 agents/venv, system PostgreSQL 16 + pgvector, Playwright Chromium,
# uv, flyctl, ruby and rsync. Private env files come from one secret bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
step() { printf '\n== %s (%ss)\n' "$1" "$SECONDS"; }
DEPS="${DEPLOY_GATE_DEPS:-/home/runner/rose-deps}"
export UV_PYTHON_INSTALL_DIR="$DEPS/uv-python"
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
# Unpacked outside the checkout: anything untracked inside it would change the frozen source digest.
bundle="$(mktemp -d)"
( umask 077 && printf %s "$DEPLOY_GATE_ENV_BUNDLE" | base64 -d | tar -xz -C "$bundle" )
for f in agents/.env back-end/.env front-end/.env agents/.env.benchmark-temporal; do
  [ -f "$bundle/$f" ] && install -m 0600 "$bundle/$f" "$ROOT/$f"
done
for f in agents/.env back-end/.env front-end/.env; do
  [ -s "$f" ] || { echo "env bundle lacks $f" >&2; exit 1; }
done
# The devbox's ngrok agent config (authtoken + API key) for run.sh's public tunnel.
if [ -f "$bundle/ngrok/ngrok.yml" ]; then
  install -D -m 0600 "$bundle/ngrok/ngrok.yml" "$HOME/.config/ngrok/ngrok.yml"
fi
rm -rf "$bundle"
# Tell the coordinator which run owns this gate (scripts/deploy_test_github.py result channel).
uv run --quiet --no-project --with boto3 --with python-dotenv python3 scripts/deploy_test_github.py remote-signal \
  --out "$RUNNER_TEMP/gate" || echo "result channel unavailable; the coordinator falls back to the GitHub API" >&2

step "git identity"
git config --global user.name "Rose Deploy Gate"
git config --global user.email "deploy-gates@roselabs.ai"

step "devbox host parity"
# The runner image trusts every repository (safe.directory=*); the devbox does not, and the
# controller-export suite asserts git refuses a foreign-owned checkout.
sudo git config --system --unset-all safe.directory || true
# The runner user's systemd --user / (sd-pam) are same-uid processes whose /proc cwd is unreadable;
# the devbox has none, and the local-cleanup scanners fail closed on them. The job runs outside them.
sudo systemctl stop "user@$(id -u).service" 2>/dev/null || true

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
# GitHub Releases has returned 504s for minutes at a time, so back off past such a window.
for attempt in 1 2 3 4 5 6; do
  command -v flyctl >/dev/null || [ -x "$HOME/.fly/bin/flyctl" ] && break
  curl -fsSL --retry 3 https://fly.io/install.sh | sh >/dev/null || { echo "flyctl install attempt $attempt failed" >&2; sleep $((attempt * 15)); }
done
[ -x "$HOME/.fly/bin/flyctl" ] || command -v flyctl >/dev/null || { echo "flyctl unavailable" >&2; exit 1; }
echo "$HOME/.fly/bin" >> "$GITHUB_PATH"

step "tunnel tools"
# run.sh needs ngrok (configured from the bundle) and cloudflared for its account-less fallback;
# the cloud benchmark lock needs shlock. Same installers as scripts/cloud-init.sh.
sudo bash scripts/cloudbench-install-ngrok.sh >/dev/null
if ! command -v cloudflared >/dev/null; then
  tmp="$(mktemp)"
  curl -fsSL --retry 3 -o "$tmp" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  sudo install -m 0755 "$tmp" /usr/local/bin/cloudflared && rm -f "$tmp"
fi
command -v shlock >/dev/null || sudo install -m 0755 scripts/lib/shlock /usr/local/bin/shlock

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
  # uv's managed CPython, as on the devbox (its build lacks os.pidfd_open and has a different
  # address-space baseline than the runner image's Python). It lives on the disk so a warm VM keeps it.
  # The stdlib venv module seeds the same pip/setuptools (ensurepip) as the devbox venv.
  uv python install --quiet "$PYTHON_VERSION"
  "$(uv python find --python-preference only-managed "$PYTHON_VERSION")" -m venv agents/venv
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
# Host facts the devbox differs on: same-uid processes whose /proc cwd is unreadable and system git config.
for p in /proc/[0-9]*; do
  [ "$(stat -c %u "$p" 2>/dev/null)" = "$(id -u)" ] || continue
  readlink "$p/cwd" >/dev/null 2>&1 && continue
  [ -d "$p" ] && printf 'unreadable cwd: pid=%s exe=%s cmd=%s\n' "${p#/proc/}" "$(readlink "$p/exe" 2>/dev/null)" \
    "$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null | cut -c1-160)"
done
git config --system --list 2>/dev/null | sed 's/^/git system config: /'
