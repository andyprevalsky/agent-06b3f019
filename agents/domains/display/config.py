"""Display domain configuration."""

TOOL_NAME = "display"

# Mirrors back-end/src/domains/agent-tools/config.ts.
DISPLAY_MAX_ITEMS = 20
DISPLAY_MAX_OPTIONS = 9
PLACEMENTS = ("inline", "pinned")
# Inline `html` travels in the activity payload (Temporal caps payloads at
# 2 MB), so it is capped well below the backend's 20 MB per-file limit.
DISPLAY_MAX_HTML_BYTES = 1_000_000
# Name the backend stores an inline page under (its .html declares the type).
DISPLAY_HTML_FILENAME = "display.html"
# Pinned questions need the Rose Desktop UI (utils.rose_desktop). The stock
# display schema has none of these arguments; the handler drops them for every
# other account, exactly as the stock schema's parse would.
PINNED_ONLY_ARGUMENTS = ("placement", "options", "allow_other")

# One backend call: URL fetches are bounded server-side (20 s each, 4 at a
# time) and uploads are ≤ 20 MB; 120 s leaves headroom without hiding a hang.
DISPLAY_ACTIVITY_TIMEOUT_SECONDS = 120
DISPLAY_ACTIVITY_MAX_ATTEMPTS = 3

# The existing approval protocol's decline sentinel (utils/attention_requests.py).
REJECTED_RESPONSE = "__REJECTED__"
