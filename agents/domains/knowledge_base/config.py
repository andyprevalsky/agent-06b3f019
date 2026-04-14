"""Constants and configuration for the knowledge-base domain."""

# Internal tools to skip when building trajectory blueprints
SKIP_TOOLS: frozenset[str] = frozenset({"check_progress", "completion_summary"})

# Maximum character length before truncating user messages in blueprints
USER_MESSAGE_TRUNCATE_LENGTH = 500

# Maximum character length for URL display in trajectory lines
URL_DISPLAY_MAX_LENGTH = 50

# Maximum character length for goal display in sub-agent trajectory lines
GOAL_DISPLAY_MAX_LENGTH = 60

# Maximum character length for error text in trajectory lines
ERROR_TEXT_MAX_LENGTH = 80
