"""Prompt for send_message_to_agent tool."""

PROMPT = """Sends a message to another agent in your agent tree, for things that need it to do new work: look something up, check, decide or act, or take in new information, a redirect or a handoff.

Anything another agent has already said, found, done or returned is in the agent tree. To learn it, spawn an explore agent to grep the agent tree; never send to ask for it. Test: could the answer already be in that agent's tree? Use an explore agent first. Send only when the work hasn't happened yet.

The recipient reads it as its next input. A running agent sees it at its next step without stopping what it is doing. A finished agent wakes up with your message as its next task, and you get a new FINAL_ANSWER agent message when it finishes again. A finished explore, browser or code task wakes the same way: its next run gets your message and its previous result."""
