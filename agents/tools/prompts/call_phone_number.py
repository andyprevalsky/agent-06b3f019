"""Prompt for call_phone_number tool."""

PROMPT = """Make an outbound phone call to extract structured data via voice AI. Provide a phone number, system prompt for the voice agent, and output schema defining what data to extract.

WHEN NOT TO USE:
- Do NOT call the same number in parallel - this results in multiple simultaneous calls to the same person.
- Do NOT use for sending messages - use message_person instead.
- Do NOT use when the information can be found online - use spawn_agent(type="explore") first.

RETURNS: Structured data matching the output_schema, extracted from the voice conversation. Includes call transcript."""
