"""Simulates user responses for clarifar's send_message_to_user calls.

Uses rose-1-lite to generate plausible user answers given
the agent's question and the original raw seed task context.
"""

import httpx
from config import load_config

SIMULATE_USER_PROMPT = """You are role-playing as a regular user who asked an AI agent to help with a task.
The agent is asking you a clarifying question. Answer naturally, concisely, and with specific details
that a real user would provide. Make up plausible specifics (names, dates, preferences) when needed.

Your original request was: "{raw_seed}"

The agent asks: "{question}"

Reply as the user would - brief, direct, with real details. Do NOT say you are an AI."""


async def simulate_user(question: str, raw_seed: str) -> str:
    """Generate a plausible user response to agent's question via rose-1-lite."""
    config = load_config()

    prompt = SIMULATE_USER_PROMPT.format(raw_seed=raw_seed, question=question)

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            config.rose.api_url,
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {config.rose.supabase_anon_key}',
                'x-api-key': config.rose.api_key,
            },
            json={
                'model': 'rose-1-lite',
                'messages': [
                    {'role': 'system', 'content': prompt},
                    {'role': 'user', 'content': question},
                ],
                'temperature': 0.8,
                'max_tokens': 300,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data['choices'][0]['message']['content'].strip()
