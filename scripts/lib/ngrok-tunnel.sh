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

public_tunnel_process_is_required() {
  local process_name="$1" ephemeral="$2"
  [ "$(public_tunnel_provider_for_mode "$ephemeral")" = "cloudflare" ] && \
    [ "$process_name" = "cloudflared" ]
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
