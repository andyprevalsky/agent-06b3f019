"""Compare Message Person's Echo and inherited-model draft quality and latency.

Run from agents/: python benchmarks/compare_message_person_models.py --repetitions 2
Pass --real-user-id to use the production recent-message context through the
same fetch activity as Message Person. No messages are sent to recipients.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from pathlib import Path
from unittest.mock import patch

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from domains.message_person.repo import fetch_recent_messages_activity, generate_message_activity
from domains.message_person.service import format_messages_for_context

REAL_BACKEND_URL = "https://navi-j9a9.onrender.com"
SCENARIOS = [
    ("friend_text", "imessage", "Sam", "Say I'm about 15 minutes late to dinner and will text when I park."),
    (
        "work_text",
        "imessage",
        "Alex",
        "Ask to move our Tuesday call to Thursday at 3 p.m.; I'll send the deck before then.",
    ),
    (
        "collaborator_email",
        "email",
        "Jordan",
        "Thank Jordan for detailed feedback on the draft, say I'll revise the examples, and propose a review call Friday at 2 p.m.",
    ),
]
THREAD_CONTEXT = {
    "friend_text": (
        "[IMESSAGE] 2026-09-29T18:00:00Z | Sam → me: still good for dinner tomorrow at 7?\n"
        "[IMESSAGE] 2026-09-29T18:04:00Z | me → Sam: yep see you then"
    ),
    "work_text": (
        "[IMESSAGE] 2026-09-28T16:00:00Z | Alex → me: Tuesday call is on the calendar.\n"
        "[IMESSAGE] 2026-09-28T16:02:00Z | me → Alex: great, I'll bring the deck"
    ),
    "collaborator_email": (
        "[EMAIL] 2026-09-27T10:00:00Z | Jordan → me: I left detailed notes on the draft examples.\n"
        "[EMAIL] 2026-09-27T10:15:00Z | me → Jordan: got them, thanks for taking a close look"
    ),
}
INTENT_VARIANTS = [
    ("15 minutes", "Thursday at 3 p.m.", "Friday at 2 p.m."),
    ("12 minutes", "Friday at 11 a.m.", "Monday at 10 a.m."),
    ("18 minutes", "Wednesday at 2 p.m.", "Thursday at 4 p.m."),
]
SYNTHETIC_MESSAGES = "\n".join(
    [
        f"[imessage] 2026-09-{(i - 1) % 28 + 1:02d}T12:00:00Z | Morgan → Friend: {text}"
        for i, text in enumerate(
            [
                "hey, I can do thursday afternoon. send me a time that works?",
                "yep sounds good. I'll take a look tonight",
                "running a little late, should be there in 10",
                "thanks for sending this over. I'll go through it tomorrow",
                "I can move the call if that's easier. friday works too",
            ]
            * 8,
            1,
        )
    ]
)


async def run_case(name: str, channel: str, person: str, intent: str, writer: str, samples: str, provider: str) -> dict:
    os.environ["ECHO_MESSAGE_PERSON_ENABLED"] = "1" if provider == "echo" else "0"
    started = time.monotonic()
    with patch("temporalio.activity.heartbeat"):
        result = await generate_message_activity(
            model="rose-1-flash",
            system_name=writer,
            conversation_context=f"[USER]: Please message {person}: {intent}",
            person_name=person,
            messages_context=THREAD_CONTEXT[name],
            exa_context="",
            intent=intent,
            channel=channel,
            general_messages_context=samples,
        )
    latency = time.monotonic() - started
    actual_model = result.get("usage", {}).get("actual_model", "rose-1-flash")
    if (provider == "echo") != (actual_model == "echo"):
        raise RuntimeError(f"{name}: expected {provider}, got {actual_model}; comparison invalid")
    return {
        "scenario": name,
        "provider": provider,
        "actual_model": actual_model,
        "latency_seconds": round(latency, 3),
        "message": result["message"],
        "subject": result.get("subject"),
        "usage": result.get("usage", {}),
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--real-user-id", help="Fetch the user's recent messages through the production backend")
    parser.add_argument("--writer", default="Morgan", help="The writer name; required with --real-user-id")
    parser.add_argument("--output", default="../.context/message-person-model-comparison.json")
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")

    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    if not os.getenv("ECHO_API_KEY"):
        raise RuntimeError("ECHO_API_KEY is required for this comparison")

    samples = SYNTHETIC_MESSAGES
    writer = args.writer
    sample_count = 40
    if args.real_user_id:
        if writer == "Morgan":
            parser.error("--writer is required with --real-user-id")
        os.environ["BACKEND_API_URL"] = REAL_BACKEND_URL
        with patch("temporalio.activity.heartbeat"):
            context = await fetch_recent_messages_activity(args.real_user_id, 100, 30)
        sample_count = context["count"]
        if sample_count < 10:
            raise RuntimeError(f"Only {sample_count} recent messages; insufficient voice context")
        samples = format_messages_for_context(context["messages"], limit=100)

    results = []
    for repetition in range(args.repetitions):
        for scenario_index, (name, channel, person, base_intent) in enumerate(SCENARIOS):
            original = INTENT_VARIANTS[0][scenario_index]
            replacement = INTENT_VARIANTS[repetition % len(INTENT_VARIANTS)][scenario_index]
            intent = base_intent.replace(original, replacement)
            # Keep repetitions semantically similar while preventing provider
            # response caching from making identical requests look unrealistically fast.
            if repetition >= len(INTENT_VARIANTS):
                intent += f" This is a separate conversation on day {repetition + 1}."
            for provider in ("echo", "previous") if repetition % 2 == 0 else ("previous", "echo"):
                row = await run_case(name, channel, person, intent, writer, samples, provider)
                results.append(row)
                print(f"{name} {provider}: {row['latency_seconds']:.1f}s ({row['actual_model']})", flush=True)

    by_provider = {
        provider: [row["latency_seconds"] for row in results if row["provider"] == provider]
        for provider in ("echo", "previous")
    }
    summary = {
        provider: {
            "count": len(times),
            "p50_seconds": round(statistics.median(times), 3),
            "p90_seconds": round(sorted(times)[max(0, (9 * len(times) + 9) // 10 - 1)], 3),
            "min_seconds": round(min(times), 3),
            "max_seconds": round(max(times), 3),
        }
        for provider, times in by_provider.items()
    }
    report = {
        "source": "real_user" if args.real_user_id else "synthetic",
        "sample_count": sample_count,
        "summary": summary,
        "results": results,
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summary, indent=2), flush=True)
    print(f"Drafts and per-case timings: {output}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
