"""Prompt for call_phone_number tool."""

PROMPT = """Use this tool to make an outbound phone call to a phone number. A voice agent will follow your system prompt and attempt to extract data matching your output schema.

Usage:
- Use when retrieving information that is only obtainable by speaking to a person (appointment confirmation, callback, voice-only verification).
- Use when you need to provide information that can only be exchanged by speaking to a person, after you have tried other available methods.
- When an automated phone menu or IVR asks you to press a button or enter digits, the voice agent uses DTMF keypad tones - never spoken digits. Multi-digit keypad entry should be sent as one tone sequence ending in # (not spoken and not paused between every digit). After sending tones, the voice agent should stay silent and listen for the next IVR prompt or result before hanging up.
- Do not use to send a written message; use message_person instead.
- Do not use for information available online; use spawn_agent(type="explore") instead.
- Do not batch parallel calls to the same number; different numbers in parallel are fine.

Returns:
- structured data matching output_schema
- the call transcript"""
