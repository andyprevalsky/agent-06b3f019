#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cloud-init.sh — one-shot, idempotent bootstrap for a fresh Cursor Cloud agent.
#
# Run this at the START of every new cloud session so the environment is set up
# correctly from the very beginning — real .env files AND a seeded database (a
# cloud agent must never come up against an empty DB).
#
# It reuses the SAME battle-tested pattern the Fly cloudbench boxes use
# (scripts/cloudbench-entrypoint.sh / cloudbench-run.sh):
#   1. Decode the injected AGENTS_ENV_B64 / BACKEND_ENV_B64 secrets into the
#      agents/.env and back-end/.env files the stack reads (whole-file base64 so
#      there is zero per-key drift; optional *_ENV_SHA256 integrity check).
#   2. Install/refresh dependencies + a local Postgres (scripts/cloud-build.sh).
#   3. Seed the local Postgres from prod (scripts/seed-local.ts, exactly as
#      scripts/run.sh / scripts/setup-db.sh do) so user data is present.
#
# Idempotent + fail-soft: missing secrets or a failed seed WARN and continue;
# they never abort (this is wired as the Cursor environment update script, which
# must never break pod startup). The seed is skipped when the dev user already
# exists, so re-runs are cheap.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '[cloud-init] %s\n' "$*"; }

DEV_USER_ID="1f85ff25-6e29-4c1b-8739-f917bd101a30"
LOCAL_DB_URL="postgresql://postgres:postgres@localhost:5432/victoria"

# ── 1. Materialize .env from injected secrets (cloudbench pattern) ────────────
umask 077
materialize_env() {
    local var_name="$1" dest="$2" sha_var="$3" label="$4"
    local b64="${!var_name:-}" sha="${!sha_var:-}"
    if [ -z "$b64" ]; then
        if [ -f "$dest" ]; then
            log "WARN: $var_name not set — keeping existing $dest"
        else
            log "WARN: $var_name not set and $dest missing — $label secrets unavailable this session"
        fi
        return 0
    fi
    if ! printf '%s' "$b64" | base64 -d > "$dest" 2>/dev/null; then
        log "WARN: failed to decode $var_name — leaving $dest unchanged"
        return 0
    fi
    chmod 600 "$dest" 2>/dev/null || true
    if [ -n "$sha" ]; then
        local got
        got="$(sha256sum "$dest" 2>/dev/null | awk '{print $1}')"
        if [ -n "$got" ] && [ "$got" != "$sha" ]; then
            log "WARN: $dest sha256 mismatch (got $got, want $sha)"
        fi
    fi
    log "wrote $dest ($(wc -l < "$dest") lines)"
}

materialize_env AGENTS_ENV_B64  agents/.env   AGENTS_ENV_SHA256  agents
materialize_env BACKEND_ENV_B64 back-end/.env BACKEND_ENV_SHA256 backend

# front-end reads only public (publishable) values; copy the committed example.
if [ ! -f front-end/.env ] && [ -f front-end/.env.example ]; then
    cp front-end/.env.example front-end/.env
    log "wrote front-end/.env (from front-end/.env.example)"
fi

# ── 2. System tools a fresh cloud box lacks (idempotent, fail-soft) ───────────
# Everything our test suites + cloud benchmark runner need beyond the base image:
#   ruby   — deploy-gate workflow-YAML checks (scripts/tests/auto-rca-workflow)
#   rsync  — cloudbench dependency sync (scripts/cloudbench-sync-deps.sh)
#   py3.11 — pinned interpreter for agents/venv (base python may be newer)
#   flyctl — REQUIRED by scripts/run-bench (the cloud Fly benchmark fleet)
#   ngrok  — public tunnel for run.sh / local benchmark stack (best-effort)
SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO="sudo"
fi

ensure_apt() {  # <binary-to-check> <apt-packages...>
    local bin="$1"; shift
    command -v "$bin" >/dev/null 2>&1 && return 0
    log "installing $* (provides $bin)…"
    $SUDO apt-get update -qq >/dev/null 2>&1 || true
    $SUDO apt-get install -y -qq "$@" >/dev/null 2>&1 || log "WARN: apt install failed: $*"
}
ensure_apt ruby ruby
ensure_apt rsync rsync

if ! command -v python3.11 >/dev/null 2>&1; then
    log "installing python3.11 (deadsnakes)…"
    $SUDO add-apt-repository -y ppa:deadsnakes/ppa >/dev/null 2>&1 || true
    $SUDO apt-get update -qq >/dev/null 2>&1 || true
    $SUDO apt-get install -y -qq python3.11 python3.11-venv python3.11-dev >/dev/null 2>&1 \
        || log "WARN: python3.11 install failed"
fi
# Pre-create the venv with 3.11 so cloud-build.sh reuses it (it would otherwise
# build with the base python3).
if command -v python3.11 >/dev/null 2>&1 && [ ! -f agents/venv/bin/activate ]; then
    python3.11 -m venv agents/venv >/dev/null 2>&1 || log "WARN: python3.11 venv create failed"
fi

if ! command -v flyctl >/dev/null 2>&1 && [ ! -x "$HOME/.fly/bin/flyctl" ]; then
    log "installing flyctl…"
    curl -fsSL https://fly.io/install.sh | sh >/dev/null 2>&1 || log "WARN: flyctl install failed"
fi
[ -x "$HOME/.fly/bin/flyctl" ] && export PATH="$HOME/.fly/bin:$PATH"

if ! command -v ngrok >/dev/null 2>&1; then
    log "installing ngrok…"
    ( curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz -o /tmp/ngrok.tgz \
        && $SUDO tar xzf /tmp/ngrok.tgz -C /usr/local/bin ngrok ) >/dev/null 2>&1 \
        || log "WARN: ngrok install failed (local-bench public tunnel only)"
fi

# ── 3. Dependencies + local Postgres (existing, validated provisioner) ────────
log "running scripts/cloud-build.sh (deps + local Postgres)…"
bash scripts/cloud-build.sh || log "WARN: cloud-build.sh returned non-zero"

# ── 4. Seed the local DB from prod so it is never empty (idempotent) ──────────
# seed-local.ts reads the REMOTE (prod) DATABASE_URL from back-end/.env and
# writes into the LOCAL DATABASE_URL we pass here — the same contract run.sh and
# setup-db.sh use. Requires the prod-backed back-end/.env from step 1; without it
# the DB keeps schema only (WARN, no abort).
seeded="$(PGPASSWORD=postgres psql -h localhost -U postgres -d victoria -tAc \
    "SELECT 1 FROM \"User\" WHERE \"userId\"='$DEV_USER_ID' LIMIT 1" 2>/dev/null | tr -d '[:space:]' || true)"
if [ "$seeded" = "1" ]; then
    log "DB already seeded (dev user present) — skipping"
else
    log "seeding local DB (schema + prod data)…"
    ( cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
        npx prisma db push --skip-generate --accept-data-loss >/dev/null 2>&1 ) \
        || log "WARN: prisma db push failed"
    ( cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
        LOCAL_DB_NAME=victoria bash scripts/apply-local-workflow-ddl.sh >/dev/null 2>&1 ) \
        || log "WARN: apply-local-workflow-ddl.sh skipped/failed"
    ( cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
        npx tsx scripts/ensure-agent-network-grep-indexes.ts >/dev/null 2>&1 ) \
        || log "WARN: ensure-agent-network-grep-indexes.ts skipped/failed"
    if ( cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
            npx tsx scripts/seed-local.ts ); then
        log "DB seeded from prod"
    else
        log "WARN: seed-local.ts failed — prod DATABASE_URL must be present in back-end/.env (BACKEND_ENV_B64). DB has schema only."
    fi
fi

log "cloud-init complete"
