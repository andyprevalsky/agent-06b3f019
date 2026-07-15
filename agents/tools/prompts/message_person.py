"""Prompt for message_person tool."""

PROMPT = """Use this tool to send a message to a phone number or email address. This tool creates the message draft from an intent you give it, blocks for human approval, and then sends the message.

Choose the transport deliberately:
- channel='imessage' sends through the user's Messages app on their Mac. The message is always queued durably. If the Mac relay is online, the tool waits briefly for confirmed send; otherwise it returns status='queued' and the Mac will send it whenever it comes back online, with no guarantee when.
- channel='agent_sms' sends immediately from the agent's own AgentPhone number. It never enters the user's iMessage queue.
- channel='email' uses the selected connected email account when delivery is available.

Delivery failures are terminal for the current tool call. In particular, never automatically retry a failed or unconfirmed agent_sms send: the provider may have accepted the message even if its receipt was lost. Report the failure or uncertain status to the user, and make another send only if the user explicitly asks for a new attempt.

Usage:
- Do not use this tool to send the user a message; use send_message_to_user (when in the PLAN phase) or send_message_to_user_execute_phase (when in the EXECUTE phase) instead."""
