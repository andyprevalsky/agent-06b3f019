"""Display domain configuration."""

TOOL_NAME = "display"

# Mirrors back-end/src/domains/agent-tools/config.ts.
DISPLAY_MAX_ITEMS = 20
DISPLAY_MAX_OPTIONS = 9
PLACEMENTS = ("inline", "pinned")

# One backend call: URL fetches are bounded server-side (20 s each, 4 at a
# time) and uploads are ≤ 20 MB; 120 s leaves headroom without hiding a hang.
DISPLAY_ACTIVITY_TIMEOUT_SECONDS = 120
DISPLAY_ACTIVITY_MAX_ATTEMPTS = 3

# The existing approval protocol's decline sentinel (utils/attention_requests.py).
REJECTED_RESPONSE = "__REJECTED__"
