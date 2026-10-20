"""Configuration for the send-message-to-user domain.

Constants, defaults, and domain-specific settings.
"""

# Timeout (minutes) before sending SMS for non-SMS-initiated goals.
SMS_FALLBACK_TIMEOUT_MINUTES = 15

# Auto-response message for sub-agents that try to ask questions.
SUB_AGENT_AUTO_RESPONSE = (
    "Please do not ask me anymore questions. I trust your judgment, intuition, "
    "and ability to make reasonable assumptions. Please proceed to the Autonomous Execution phase."
)

# Inline view props live in message metadata; larger data belongs in a file.
INLINE_VIEW_MAX_PROPS_BYTES = 64 * 1024
