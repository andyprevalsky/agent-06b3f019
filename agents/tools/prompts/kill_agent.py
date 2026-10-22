"""Prompt for kill_agent tool."""

PROMPT = """Kills an agent below you and everything it spawned, or one of your own background tasks. A killed agent fails with the reason "Killed by <your address>".

Use it when a branch of work is no longer needed or is going the wrong way and should not be redirected. It only works on your descendants: you cannot kill yourself, your parent or other branches (ask their owner with send_message_to_agent instead)."""
