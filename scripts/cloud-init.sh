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

# Cursor Cloud often injects per-key Secrets without AGENTS_ENV_B64 /
# BACKEND_ENV_B64. When the whole-file blob is absent, synthesize .env from the
# injected process env so children that load dotenv (Prisma seed, run.sh helpers)
# still see the same secrets as the parent shell.
materialize_env_from_injected_process() {
    local dest="$1" label="$2"
    if [ -f "$dest" ]; then
        return 0
    fi
    local names="${CLOUD_AGENT_INJECTED_SECRET_NAMES:-}"
    if [ -z "$names" ]; then
        log "WARN: no $dest and no CLOUD_AGENT_INJECTED_SECRET_NAMES — $label .env not synthesized"
        return 0
    fi
    DEST="$dest" NAMES="$names" python3 - <<'PY'
import os
from pathlib import Path

dest = Path(os.environ["DEST"])
names = [n.strip() for n in os.environ["NAMES"].split(",") if n.strip()]
lines = []
for name in names:
    val = os.environ.get(name)
    if val is None or val == "":
        continue
    if any(ch in val for ch in ' \t\n"\'#$`\\'):
        escaped = val.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'{name}="{escaped}"')
    else:
        lines.append(f"{name}={val}")
dest.write_text("\n".join(lines) + ("\n" if lines else ""))
os.chmod(dest, 0o600)
print(len(lines))
PY
    local count
    count="$(wc -l < "$dest" 2>/dev/null | tr -d ' ' || echo 0)"
    log "synthesized $dest from injected Cursor secrets ($count keys) for $label"
}

materialize_env_from_injected_process agents/.env agents
materialize_env_from_injected_process back-end/.env backend

# Always keep ngrok credentials in both .env files when the process has them.
# NGROK_API_KEY must be the secret token (FIRSTPART_SECONDPART), NOT the key ID
# (ak_…). An ID fails reserved-domain list with ERR_NGROK_208 / 403 and tears
# down run.sh before the public tunnel starts.
upsert_env_key() {
    local dest="$1" key="$2" val="$3"
    [ -n "$val" ] || return 0
    [ -f "$dest" ] || printf '' > "$dest"
    DEST="$dest" KEY="$key" VAL="$val" python3 - <<'PY'
import os
from pathlib import Path

p = Path(os.environ["DEST"])
key = os.environ["KEY"]
val = os.environ["VAL"]
if any(ch in val for ch in ' \t\n"\'#$`\\'):
    escaped = val.replace("\\", "\\\\").replace('"', '\\"')
    rendered = f'{key}="{escaped}"'
else:
    rendered = f"{key}={val}"
lines = p.read_text().splitlines() if p.exists() else []
out = []
found = False
for line in lines:
    if line.startswith(key + "="):
        out.append(rendered)
        found = True
    else:
        out.append(line)
if not found:
    out.append(rendered)
p.write_text("\n".join(out) + "\n")
os.chmod(p, 0o600)
PY
}

if [ -n "${NGROK_API_KEY:-}" ]; then
    case "${NGROK_API_KEY}" in
        ak_*)
            log "WARN: NGROK_API_KEY looks like a key ID (ak_…), not the secret token — reserved-domain API will fail. Paste the Reveal/copy token (FIRSTPART_SECONDPART) from dashboard.ngrok.com/api-keys"
            ;;
        *)
            for envf in agents/.env back-end/.env; do
                upsert_env_key "$envf" NGROK_API_KEY "$NGROK_API_KEY"
            done
            log "synced NGROK_API_KEY into agents/.env and back-end/.env"
            ;;
    esac
fi
if [ -n "${BROWSER_USE_API_KEY:-}" ]; then
    for envf in agents/.env back-end/.env; do
        upsert_env_key "$envf" BROWSER_USE_API_KEY "$BROWSER_USE_API_KEY"
    done
    log "synced BROWSER_USE_API_KEY into agents/.env and back-end/.env"
fi
if [ "${BROWSER_AGENT_BROWSER_USE_ENABLED+x}" = x ]; then
    for envf in agents/.env back-end/.env; do
        upsert_env_key "$envf" BROWSER_AGENT_BROWSER_USE_ENABLED "${BROWSER_AGENT_BROWSER_USE_ENABLED:-false}"
    done
    log "synced BROWSER_AGENT_BROWSER_USE_ENABLED into agents/.env and back-end/.env"
fi
# Tilion (default browser provider): mirror injected credentials/tuning so
# dotenv children agree with this shell. Values are never logged.
for key in TILION_API_KEY TILION_BASE_URL TILION_SESSION_TTL_SECONDS \
    TILION_IDLE_TIMEOUT_SECONDS TILION_CDP_OBSERVE; do
    if [ -n "${!key:-}" ]; then
        for envf in agents/.env back-end/.env; do
            upsert_env_key "$envf" "$key" "${!key}"
        done
        log "synced $key into agents/.env and back-end/.env"
    fi
done
# The kill switch mirrors like the Browser Use flag: injected-but-empty is
# "unset" (default on), so only a non-empty value overwrites a stale one.
if [ -n "${BROWSER_AGENT_TILION_ENABLED:-}" ]; then
    for envf in agents/.env back-end/.env; do
        upsert_env_key "$envf" BROWSER_AGENT_TILION_ENABLED "$BROWSER_AGENT_TILION_ENABLED"
    done
    log "synced BROWSER_AGENT_TILION_ENABLED into agents/.env and back-end/.env"
fi
# Injected Cursor GITHUB_TOKEN is often an invalid github_pat_ that `gh auth
# token` still echoes back. Overwrite process env + local .env with the working
# hosts.yml / insteadOf credential so children inherit a valid token.
if [ -f "$ROOT/scripts/lib/cloudbench-env.sh" ]; then
    # shellcheck source=lib/cloudbench-env.sh
    source "$ROOT/scripts/lib/cloudbench-env.sh"
    if cloudbench_export_controller_github_token agents/.env back-end/.env; then
        log "exported working GITHUB_TOKEN into process env + agents/.env + back-end/.env (len=${#GITHUB_TOKEN})"
    else
        log "WARN: could not resolve a working GITHUB_TOKEN from gh hosts.yml / git insteadOf"
    fi
fi

if [ -n "${NGROK_AUTHTOKEN:-}" ]; then
    for envf in agents/.env back-end/.env; do
        upsert_env_key "$envf" NGROK_AUTHTOKEN "$NGROK_AUTHTOKEN"
    done
    if command -v ngrok >/dev/null 2>&1; then
        HOME="${HOME:-/home/ubuntu}" ngrok config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null 2>&1 \
            || log "WARN: ngrok config add-authtoken failed"
    fi
    log "synced NGROK_AUTHTOKEN into .env + ngrok config"
fi

# seed-local.ts reads the REMOTE DATABASE_URL from back-end/.env (run.sh
# overrides process.env to the local DB). Cursor Cloud also injects the prod
# pooled URL into the process environment; if .env was rewritten to localhost
# (or BACKEND_ENV_B64 was missing), restore the injected remote so compute-token
# sync / AgentCard can still pull gpt_code + claude_code from prod.
if [ -f back-end/.env ]; then
    env_db="$(grep -E '^DATABASE_URL=' back-end/.env | head -1 | cut -d= -f2- | tr -d '"' || true)"
    case "${DATABASE_URL:-}" in
        *supabase.com*|*pooler.supabase.com*|*aws-*.supabase.com*)
            case "$env_db" in
                *localhost*|*127.0.0.1*|"" )
                    log "restoring prod DATABASE_URL into back-end/.env from injected process env (was local/empty)"
                    # Preserve any other keys; rewrite only the DB endpoints seed-local reads.
                    if grep -q '^DATABASE_URL=' back-end/.env; then
                        sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"${DATABASE_URL}\"|" back-end/.env
                    else
                        printf '\nDATABASE_URL="%s"\n' "$DATABASE_URL" >> back-end/.env
                    fi
                    if [ -n "${DIRECT_URL:-}" ]; then
                        if grep -q '^DIRECT_URL=' back-end/.env; then
                            sed -i "s|^DIRECT_URL=.*|DIRECT_URL=\"${DIRECT_URL}\"|" back-end/.env
                        else
                            printf 'DIRECT_URL="%s"\n' "$DIRECT_URL" >> back-end/.env
                        fi
                    fi
                    ;;
            esac
            ;;
    esac
fi

# front-end reads only public (publishable) values; copy the committed example.
if [ ! -f front-end/.env ] && [ -f front-end/.env.example ]; then
    cp front-end/.env.example front-end/.env
    log "wrote front-end/.env (from front-end/.env.example)"
fi

# Injected Cursor Secrets override dotenv (Node/Python keep existing env). An
# unsupported BROWSER_PROVIDER (e.g. browserbase) makes live /init 500. Force a
# supported value into this shell AND rewrite .env so children agree. Tilion is
# the default provider but needs TILION_API_KEY; without one the box uses kernel.
case "${BROWSER_PROVIDER:-}" in
  tilion|kernel|steel|browser-use) ;;
  *)
    forced_provider=kernel
    if [ -n "${TILION_API_KEY:-}" ] ||
      grep -Eq '^TILION_API_KEY=["'"'"']?[^"'"'"'[:space:]]' back-end/.env 2>/dev/null; then
      forced_provider=tilion
    fi
    log "WARN: BROWSER_PROVIDER='${BROWSER_PROVIDER:-}' unsupported — forcing $forced_provider"
    export BROWSER_PROVIDER="$forced_provider"
    for envf in back-end/.env agents/.env; do
      if [ -f "$envf" ]; then
        if grep -q '^BROWSER_PROVIDER=' "$envf" 2>/dev/null; then
          sed -i "s/^BROWSER_PROVIDER=.*/BROWSER_PROVIDER=\"$forced_provider\"/" "$envf"
        else
          printf '\nBROWSER_PROVIDER="%s"\n' "$forced_provider" >> "$envf"
        fi
      fi
    done
    ;;
esac

# ── 2. System tools a fresh cloud box lacks (idempotent, fail-soft) ───────────
# Everything our test suites + cloud benchmark runner need beyond the base image:
#   ruby   — workflow-YAML parse fallback (scripts/tests/mac-app-release-drift)
#   rsync  — cloudbench dependency sync (scripts/cloudbench-sync-deps.sh)
#   lsof   — local stack/benchmark cleanup finds listener PIDs and process cwds
#   time   — GNU /usr/bin/time for seed-memory RSS ratchet (bash builtin has no RSS)
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
ensure_apt lsof lsof
# Prefer the real /usr/bin/time binary; `command -v time` hits the bash builtin.
if [ ! -x /usr/bin/time ]; then
    ensure_apt /usr/bin/time time
fi

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
    $SUDO bash "$ROOT/scripts/cloudbench-install-ngrok.sh" >/dev/null 2>&1 \
        || log "WARN: ngrok install failed (local-bench public tunnel only)"
fi

# Isolated benchmark stacks (scripts/run.sh --benchmark, and therefore every
# `run-bench --local` / `/deploy` smoke run) publish their public origin through
# cloudflared, NOT ngrok — run.sh hard-fails with "cloudflared is required for
# isolated benchmark public tunnels" when it is missing, which aborts the whole
# smoke gate before a single task starts.
if ! command -v cloudflared >/dev/null 2>&1; then
    log "installing cloudflared…"
    # Match the host architecture. Installing the amd64 artifact on arm64 yields
    # a binary that cannot exec, and run.sh then hard-fails the whole smoke gate
    # on a missing tunnel. uname is used rather than dpkg because this script
    # also runs on rpm-based images (Amazon Linux) that ship no dpkg.
    case "$(uname -m)" in
        x86_64|amd64) CLOUDFLARED_ARCH=amd64 ;;
        aarch64|arm64) CLOUDFLARED_ARCH=arm64 ;;
        *) CLOUDFLARED_ARCH="" ;;
    esac
    if [ -z "$CLOUDFLARED_ARCH" ]; then
        log "WARN: unsupported architecture $(uname -m) for cloudflared; skipping install"
    else
        CLOUDFLARED_TMP="$(mktemp "${TMPDIR:-/tmp}/cloudflared.XXXXXX")"
        ( curl -fsSL --connect-timeout 10 --max-time 120 \
            --retry 2 --retry-delay 2 --retry-max-time 300 \
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CLOUDFLARED_ARCH}" \
            -o "$CLOUDFLARED_TMP" \
            && $SUDO install -m 0755 "$CLOUDFLARED_TMP" /usr/local/bin/cloudflared ) >/dev/null 2>&1 \
            || log "WARN: cloudflared install failed (isolated benchmark tunnels will fail)"
        rm -f "$CLOUDFLARED_TMP"
    fi
fi

# shlock — the cloud benchmark fleet's cross-workspace app-env lock requires it
# (scripts/lib/cloudbench-app-env-lock.sh). The baked Fly bench image ships the
# real INN shlock; a bare cloud VM does not, so install the repo fallback.
if ! command -v shlock >/dev/null 2>&1 && [ -f "$ROOT/scripts/lib/shlock" ]; then
    log "installing shlock (cloudbench app-env lock)…"
    $SUDO install -m 0755 "$ROOT/scripts/lib/shlock" /usr/local/bin/shlock 2>/dev/null \
        || { mkdir -p "$HOME/.local/bin" && install -m 0755 "$ROOT/scripts/lib/shlock" "$HOME/.local/bin/shlock"; } \
        || log "WARN: shlock install failed"
fi

# ── 3. Dependencies + local Postgres (existing, validated provisioner) ────────
log "running scripts/cloud-build.sh (deps + local Postgres)…"
bash scripts/cloud-build.sh || log "WARN: cloud-build.sh returned non-zero"

# ── 4. Seed the local DB from prod so it is never empty (idempotent) ──────────
# seed-local.ts reads the REMOTE (prod) DATABASE_URL from back-end/.env and
# writes into the LOCAL DATABASE_URL we pass here — the same contract run.sh and
# setup-db.sh use. Requires the prod-backed back-end/.env from step 1; without it
# the DB keeps schema only (WARN, no abort).
# localhost:5432 is run.sh's database only on its system-Postgres fallback
# (ROSE_USE_SYSTEM_PG=true, or no Docker daemon — the predicate cloud-build.sh
# uses to provision that cluster). With Docker, run.sh creates and first-run
# seeds its workspace container on LOCAL_DB_PORT, so a snapshot's stopped system
# cluster must not be started and seeded in its place.
seed_system_pg=true
if [ "${ROSE_USE_SYSTEM_PG:-false}" != "true" ] && timeout 10 docker info >/dev/null 2>&1; then
    seed_system_pg=false
fi
if $seed_system_pg && ! pg_isready -h localhost -p 5432 -q 2>/dev/null && command -v pg_ctlcluster >/dev/null 2>&1; then
    log "starting the installed system Postgres on localhost:5432…"
    $SUDO service postgresql start >/dev/null 2>&1 || log "WARN: system Postgres did not start"
fi
seeded=""
$seed_system_pg && seeded="$(PGPASSWORD=postgres psql -h localhost -U postgres -d victoria -tAc \
    "SELECT 1 FROM \"User\" WHERE \"userId\"='$DEV_USER_ID' LIMIT 1" 2>/dev/null | tr -d '[:space:]' || true)"
if ! $seed_system_pg; then
    log "Docker is available: run.sh creates and seeds its workspace database on first start — skipping the system-Postgres seed"
elif [ "$seeded" = "1" ]; then
    log "DB already seeded (dev user present) — skipping"
elif ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
    log "WARN: no Postgres is reachable at localhost:5432 — skipping the seed. DB is empty."
else
    log "seeding local DB (schema + prod data)…"
    # --no-install: when dependency setup failed, npx would otherwise wait on a
    # hidden "Ok to proceed?" install prompt (output is discarded) forever.
    ( cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
        npx --no-install prisma db push --skip-generate --accept-data-loss >/dev/null 2>&1 ) \
        || log "WARN: prisma db push failed"
    ( cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
        LOCAL_DB_NAME=victoria bash scripts/apply-local-workflow-ddl.sh >/dev/null 2>&1 ) \
        || log "WARN: apply-local-workflow-ddl.sh skipped/failed"
    ( cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
        npx --no-install tsx scripts/ensure-agent-network-grep-indexes.ts >/dev/null 2>&1 ) \
        || log "WARN: ensure-agent-network-grep-indexes.ts skipped/failed"
    if ( cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
            NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=96" \
            npx --no-install tsx scripts/seed-local.ts ); then
        log "DB seeded from prod"
    else
        log "WARN: seed-local.ts failed — prod DATABASE_URL must be present in back-end/.env (BACKEND_ENV_B64). DB has schema only."
    fi
fi

log "cloud-init complete"
