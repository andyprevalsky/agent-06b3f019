#!/usr/bin/env bash

# Sourceable public-tunnel publication helpers shared by run.sh and deterministic
# RCA tests. These functions do not start an agent or access a provider API.

NGROK_ENDPOINT_ARGS=()
NGROK_RESERVE_DOMAIN=0

public_tunnel_provider_for_mode() {
  case "${1:-}" in
    1) printf '%s\n' cloudflare ;;
    0) printf '%s\n' ngrok ;;
    *) return 2 ;;
  esac
}

# An isolated run hands its account-less tunnel URL to the harness, so losing
# that tunnel fails the run. A shared stack serves localhost first: whichever
# provider fronts it publicly (including an ERR_NGROK_334 fallback) is optional.
public_tunnel_process_is_required() {
  local process_name="$1" ephemeral="$2"
  if [ -n "${DEPLOY_SEMANTIC_CALLBACK_TOKEN:-}" ]; then
    [ "$process_name" = ngrok ]
    return
  fi
  [ "$(public_tunnel_provider_for_mode "$ephemeral")" = "cloudflare" ] || return 1
  [ "$process_name" = "cloudflared" ]
}

public_tunnel_process_is_optional() {
  local process_name="$1" ephemeral="$2"
  case "$process_name" in
    ngrok|cloudflared) ;;
    *) return 1 ;;
  esac
  ! public_tunnel_process_is_required "$process_name" "$ephemeral"
}

# ERR_NGROK_334: the bound domain is already online in a different agent
# session. That session can belong to another checkout or another VM booted
# from the same environment snapshot, so it is never this stack's to stop.
ngrok_log_reports_endpoint_online_elsewhere() {
  [ -f "${1:-}" ] && grep -q 'ERR_NGROK_334' "$1"
}

ngrok_configure_endpoint_mode() {
  local ephemeral="$1" domain="${2:-}"
  NGROK_ENDPOINT_ARGS=()
  NGROK_RESERVE_DOMAIN=0
  if [ "$ephemeral" = "1" ]; then
    return 0
  fi
  [ -n "$domain" ] || return 2
  NGROK_ENDPOINT_ARGS=(--domain "$domain")
  NGROK_RESERVE_DOMAIN=1
}

# Classify a malformed NGROK_API_KEY before spending an API round-trip on it,
# and print the specific defect. A valid key is `FIRSTPART_SECONDPART`.
#
# Both defects below have already cost real debugging time. A stray apostrophe
# captured inside the .env value (`NGROK_API_KEY="..fmmT'"`) made a perfectly
# good key return an opaque 403 "properly formed, but it is invalid" — which was
# filed as a *stale* key on 2026-07-27 and left every workspace's key broken for
# a week, when the actual fix was deleting one character. The other is pasting
# the dashboard's `ak_...` key *ID* instead of the token it identifies.
#
# ngrok's own 400 for the ID case is excellent; its 403 for the quote case is
# actively misleading. Name the defect so the next reader doesn't re-derive it.
ngrok_api_key_defect() {
    local key="${1:-}"
    [ -n "$key" ] || return 1
    case "$key" in
        ak_*) printf '%s\n' "looks like an API key ID (ak_...), not the key token"; return 0 ;;
        *\'*|*\"*) printf '%s\n' "contains a quote character (stray quote in .env?)"; return 0 ;;
        *[[:space:]]*) printf '%s\n' "contains whitespace"; return 0 ;;
        *_*) return 1 ;;
        *) printf '%s\n' "is not in FIRSTPART_SECONDPART form"; return 0 ;;
    esac
}

# Pre-reserve an ngrok domain, defaulting to this worktree's primary domain.
#
# Reservation is ADVISORY, never authoritative. `--domain` binds with only an
# agent authtoken on our plan, so the API key here buys nothing except a
# friendlier error earlier. This used to `exit 1` on any API rejection, which
# meant a rotated-out NGROK_API_KEY took down every stack that merely *had* the
# variable set — while the tunnel it was gating would have come up fine. An
# absent key was tolerated but a stale one was fatal, which is backwards.
#
# The authoritative check is the agent actually publishing the endpoint moments
# later; that path already prints the actionable billing/plan guidance. So every
# failure here degrades to a warning and returns success, and callers under
# `set -e` flow straight through to the real check.
ensure_ngrok_domain_reserved() {
    local domain="${1:-${WORKTREE_DOMAIN:-}}"
    [ -n "$domain" ] || return 0
    [ -n "${NGROK_API_KEY:-}" ] || return 0

    local defect
    if defect="$(ngrok_api_key_defect "$NGROK_API_KEY")"; then
        echo "⚠️  NGROK_API_KEY $defect — skipping domain pre-reservation."
        echo "   Fix it in back-end/.env; --domain still binds via the agent authtoken."
        return 0
    fi

    echo "🌐 Checking ngrok reserved domain $domain"
    local domains_json
    if ! domains_json=$(ngrok api reserved-domains list \
        --api-key "$NGROK_API_KEY" --limit 1000 2>&1); then
        printf '%s\n' "$domains_json"
        echo "⚠️  Could not list ngrok reserved domains (NGROK_API_KEY stale, rotated, or unscoped)."
        echo "   Continuing — --domain binds without an API key; the tunnel start is authoritative."
        return 0
    fi

    # Compare the reserved domain literally. A grep pattern treats the dots in a
    # hostname as wildcards, so `rose-x.ngrok.app` would also match an unrelated
    # reservation such as `rose-xyngrok.app` and skip a reserve we actually need.
    # ngrok CLI may prefix JSON with an HTTP status line (e.g. "200 OK").
    if printf '%s\n' "$domains_json" | NGROK_WANT_DOMAIN="$domain" python3 -c '
import json, os, sys

want = os.environ["NGROK_WANT_DOMAIN"]
raw = sys.stdin.read()
brace = raw.find("{")
if brace < 0:
    sys.exit(1)
try:
    payload = json.loads(raw[brace:])
except ValueError:
    sys.exit(1)
entries = payload.get("reserved_domains", []) if isinstance(payload, dict) else payload
if not isinstance(entries, list):
    sys.exit(1)
sys.exit(0 if any(isinstance(e, dict) and e.get("domain") == want for e in entries) else 1)
'; then
        echo "🌐 Reserved domain already exists: $domain"
        return 0
    fi

    echo "🌐 Reserving ngrok domain $domain"
    local create_output
    if ! create_output=$(ngrok api reserved-domains create \
        --api-key "$NGROK_API_KEY" \
        --domain "$domain" \
        --description "Conductor workspace ${CONDUCTOR_WORKSPACE_NAME:-unknown} public frontend" 2>&1); then
        printf '%s\n' "$create_output"
        echo "⚠️  Could not reserve $domain. Continuing — the tunnel start is authoritative."
        return 0
    fi
}

public_tunnel_publish_environment() {
  local public_url="$1" existing_origins="${2:-}"
  [ -n "$public_url" ] || return 1
  PUBLIC_TUNNEL_URL="$public_url" python3 - <<'PY' || return 1
import os
from urllib.parse import urlsplit

parsed = urlsplit(os.environ["PUBLIC_TUNNEL_URL"])
try:
    port = parsed.port
except ValueError:
    raise SystemExit(1)
if (
    parsed.scheme != "https"
    or not parsed.hostname
    or parsed.username is not None
    or parsed.password is not None
    or port is not None
    or parsed.netloc != parsed.hostname
    or parsed.path not in ("", "/")
    or parsed.query
    or parsed.fragment
):
    raise SystemExit(1)
PY

  PUBLIC_BASE_URL="$public_url"
  WORKTREE_DOMAIN="${PUBLIC_BASE_URL#https://}"
  VITE_ALLOWED_HOSTS="$WORKTREE_DOMAIN"
  case ",$existing_origins," in
    *",$PUBLIC_BASE_URL,"*) ALLOWED_ORIGINS="$existing_origins" ;;
    *) ALLOWED_ORIGINS="${existing_origins}${existing_origins:+,}$PUBLIC_BASE_URL" ;;
  esac
  export PUBLIC_BASE_URL WORKTREE_DOMAIN VITE_ALLOWED_HOSTS ALLOWED_ORIGINS
}

ngrok_publish_reported_environment() {
  local response_file="$1" existing_origins="${2:-}" public_url
  [ -f "$response_file" ] || return 1
  public_url="$(NGROK_RESPONSE_FILE="$response_file" python3 - <<'PY'
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

try:
    payload = json.loads(Path(os.environ["NGROK_RESPONSE_FILE"]).read_text())
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)

for tunnel in payload.get("tunnels", []):
    if not isinstance(tunnel, dict):
        continue
    value = tunnel.get("public_url")
    if tunnel.get("proto") != "https" or not isinstance(value, str):
        continue
    parsed = urlsplit(value.strip())
    if parsed.scheme == "https" and parsed.netloc and parsed.path in ("", "/") and not parsed.query and not parsed.fragment:
        print(f"https://{parsed.netloc}")
        raise SystemExit(0)
raise SystemExit(1)
PY
  )" || return 1
  public_tunnel_publish_environment "$public_url" "$existing_origins"
}

cloudflare_publish_reported_environment() {
  local log_file="$1" existing_origins="${2:-}" public_url
  [ -f "$log_file" ] || return 1
  public_url="$(CLOUDFLARE_LOG_FILE="$log_file" python3 - <<'PY'
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

try:
    text = Path(os.environ["CLOUDFLARE_LOG_FILE"]).read_text(errors="replace")
except OSError:
    raise SystemExit(1)

for value in re.findall(r"https://[^\s|]+", text):
    value = value.rstrip(".,;)")
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError:
        continue
    if (
        parsed.scheme == "https"
        and parsed.hostname
        and parsed.hostname.endswith(".trycloudflare.com")
        and parsed.username is None
        and parsed.password is None
        and port is None
        and parsed.netloc == parsed.hostname
        and parsed.path in ("", "/")
        and not parsed.query
        and not parsed.fragment
    ):
        print(f"https://{parsed.netloc}")
        raise SystemExit(0)
raise SystemExit(1)
PY
  )" || return 1
  public_tunnel_publish_environment "$public_url" "$existing_origins"
}

public_tunnel_publish_url_manifest() {
  local manifest="$1"
  [ -f "$manifest" ] && [ -n "${PUBLIC_BASE_URL:-}" ] || return 1
  SERVICES_MANIFEST="$manifest" PUBLIC_BASE_URL="$PUBLIC_BASE_URL" python3 - <<'PY'
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

path = Path(os.environ["SERVICES_MANIFEST"])
public_url = os.environ["PUBLIC_BASE_URL"]
parsed = urlsplit(public_url)
try:
    port = parsed.port
except ValueError:
    raise SystemExit(1)
if (
    parsed.scheme != "https"
    or not parsed.hostname
    or parsed.username is not None
    or parsed.password is not None
    or port is not None
    or parsed.netloc != parsed.hostname
    or parsed.path not in ("", "/")
    or parsed.query
    or parsed.fragment
):
    raise SystemExit(1)
data = json.loads(path.read_text())
urls = data.setdefault("urls", {})
urls["public"] = f"https://{parsed.netloc}"
tmp = path.with_suffix(path.suffix + ".tmp")
tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
tmp.replace(path)
PY
}

# Backwards-compatible name for callers outside run.sh.
ngrok_publish_public_url_manifest() {
  public_tunnel_publish_url_manifest "$@"
}
