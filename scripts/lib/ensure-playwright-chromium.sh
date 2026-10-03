#!/usr/bin/env bash
# Install Playwright's Chromium only when a required browser revision is missing.
#
# `playwright install` always takes the host-wide ms-playwright cache dirlock,
# even when every browser is already installed. Every Conductor workspace's
# coverage gate runs it, and under host load the lock heartbeat goes stale
# ("Unable to update lock within the stale threshold ... __dirlock"), which
# crashes the whole coverage lane before a single test runs. Read the install
# locations from `install --dry-run` (no lock) and skip the locked install when
# each one already carries Playwright's INSTALLATION_COMPLETE marker.
#
# Usage (source this file first):
#   ensure_playwright_chromium "$PYTHON_BIN" -m playwright
#   ensure_playwright_chromium npx playwright

ensure_playwright_chromium() {
  local plan location count=0 missing=0
  plan="$("$@" install --dry-run chromium 2>/dev/null)" || plan=""
  while IFS= read -r location; do
    [ -n "$location" ] || continue
    count=$((count + 1))
    [ -f "$location/INSTALLATION_COMPLETE" ] || missing=1
  done <<EOF
$(printf '%s\n' "$plan" | sed -n 's/^[[:space:]]*Install location:[[:space:]]*//p')
EOF

  if [ "$count" -gt 0 ] && [ "$missing" -eq 0 ]; then
    echo "Playwright chromium already installed ($count components); skipping the locked install"
    return 0
  fi
  "$@" install chromium
}
