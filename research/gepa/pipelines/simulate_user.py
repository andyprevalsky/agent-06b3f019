"""Simulates user responses for clarifar's send_message_to_user calls.

NOTE: This pipeline used to call the Supabase /completions edge function to
drive rose-1-lite. That endpoint was retired along with the rest of the
research stack; gepa's user-simulation loop is disabled until it's rewired to
the in-process provider at `back-end/src/providers/rose/` or `agents/providers/rose/`.
"""


async def simulate_user(question: str, raw_seed: str) -> str:
    raise RuntimeError(
        "simulate_user is disabled: the Supabase /completions endpoint has been "
        "removed. Rewire this to call the in-process Rose provider if gepa needs "
        "to resume."
    )
