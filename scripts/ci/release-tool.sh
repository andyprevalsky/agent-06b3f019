# Sourced by scripts/ci/deploy-gate-setup.sh.
#
# release_tool <name> <installed path> <installer command...>
#
# GitHub Releases has answered 504 for tens of minutes at a time (2026-11-08: flyctl, cloudflared
# and uv assets together, while githubstatus.com reported operational), failing every gate VM in
# Prepare runner. Each successful install refreshes "$RELEASE_TOOL_CACHE/<name>" on the dependency
# disk. When the installer fails and that last good copy exists, the copy is installed at once;
# otherwise the installer is retried with bounded backoff. Only a disk that never had the tool
# waits out an outage.
release_tool() {
  local name=$1 target=$2 attempt
  shift 2
  for attempt in 1 2 3 4 5 6; do
    if "$@" && [ -x "$target" ]; then
      mkdir -p "$RELEASE_TOOL_CACHE" && cp "$target" "$RELEASE_TOOL_CACHE/$name.tmp" \
        && mv -f "$RELEASE_TOOL_CACHE/$name.tmp" "$RELEASE_TOOL_CACHE/$name"
      return 0
    fi
    echo "$name install attempt $attempt failed" >&2
    if [ -x "$RELEASE_TOOL_CACHE/$name" ]; then
      echo "$name: installing the dependency disk's last good copy" >&2
      case "$target" in
        "$HOME"/*) install -D -m 0755 "$RELEASE_TOOL_CACHE/$name" "$target" ;;
        *) sudo install -D -m 0755 "$RELEASE_TOOL_CACHE/$name" "$target" ;;
      esac
      return
    fi
    [ "$attempt" -lt 6 ] && sleep $((attempt * ${RELEASE_TOOL_RETRY_SECONDS:-15}))
  done
  echo "$name unavailable: its installer failed 6 times and the dependency disk has no copy" >&2
  return 1
}
