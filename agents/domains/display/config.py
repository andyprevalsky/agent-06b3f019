"""Display domain configuration."""

TOOL_NAME = "display"

# Mirrors back-end/src/domains/agent-tools/config.ts.
DISPLAY_MAX_ITEMS = 20
# Inline `html` travels in the activity payload (Temporal caps payloads at
# 2 MB), so it is capped well below the backend's 20 MB per-file limit.
DISPLAY_MAX_HTML_BYTES = 1_000_000
# Name the backend stores an inline page under (its .html declares the type).
DISPLAY_HTML_FILENAME = "display.html"
# display never asks a question: these pinned-question arguments are refused
# for every account (agents cannot ask the user through display).
QUESTION_ARGUMENTS = ("placement", "options", "allow_other")

# One backend call: URL fetches are bounded server-side (20 s each, 4 at a
# time) and uploads are ≤ 20 MB; 120 s leaves headroom without hiding a hang.
DISPLAY_ACTIVITY_TIMEOUT_SECONDS = 120
DISPLAY_ACTIVITY_MAX_ATTEMPTS = 3
