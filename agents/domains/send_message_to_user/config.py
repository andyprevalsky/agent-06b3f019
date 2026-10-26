"""Configuration for the send-message-to-user domain.

Constants, defaults, and domain-specific settings.
"""

# Timeout (minutes) before sending SMS for non-SMS-initiated goals.
SMS_FALLBACK_TIMEOUT_MINUTES = 15

# Reply posted when a sub-agent asks the user a question: the user cannot see
# sub-agent questions, so it explains how to ask the parent instead.
SUB_AGENT_AUTO_RESPONSE = (
    "You are a sub-agent; the user can't see this. To ask for clarification, "
    'send_message_to_agent(to="parent", ...) and then wait_for(agents=["parent"]) for the reply; '
    "your parent answers or asks the user. Otherwise proceed on reasonable assumptions."
)

# Inline view props live in message metadata; larger data belongs in a file.
INLINE_VIEW_MAX_PROPS_BYTES = 64 * 1024
