"""Prompt for call_phone_number tool."""

PROMPT = """Places an outbound phone call where a voice agent follows your system prompt and extracts data matching your output schema.

Usage:
- Use when the information is only obtainable by speaking to a person (appointment confirmation, callback, voice-only verification).
- Do not use to send a written message - use message_person.
- Do not use for information available online - use spawn_explore_agent.
- Do not batch parallel calls to the same number; different numbers in parallel are fine.
- Returns structured data matching output_schema plus the call transcript."""
