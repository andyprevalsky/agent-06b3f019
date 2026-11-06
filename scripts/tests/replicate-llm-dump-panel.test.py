"""Offline regression: replay panels apply counterfactual text everywhere and count first-tool decisions."""
from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "replicate_llm_dump.py"
spec = importlib.util.spec_from_file_location("replicate_llm_dump", SCRIPT)
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)

DECLINE = 'The user declined the request "Sign in to shop".'


def dump() -> dict:
    return {
        "call_site": "execute_loop",
        "messages": [
            {"role": "system", "content": "rules"},
            {"role": "assistant", "content": f"Payload:\n{DECLINE}"},
            {"role": "assistant", "content": "", "tool_calls": [{"function": {
                "name": "spawn_agent", "arguments": json.dumps({"type": "explore", "goal": f"It said '{DECLINE}'"})}}]},
        ],
    }


class ReplayPanelTests(unittest.TestCase):
    def test_replacement_reaches_bodies_and_json_tool_arguments(self):
        data = dump()
        self.assertEqual(replay.apply_replacements(data, [[DECLINE, "NEW \"quoted\" text"]]), 2)
        self.assertIn('NEW "quoted" text', data["messages"][1]["content"])
        goal = json.loads(data["messages"][2]["tool_calls"][0]["function"]["arguments"])["goal"]
        self.assertEqual(goal, "It said 'NEW \"quoted\" text'")

    def test_unmatched_replacement_fails_instead_of_replaying_the_baseline(self):
        with self.assertRaises(SystemExit):
            replay.apply_replacements(dump(), [["absent text", "x"]])

    def test_first_tool_decision_names_spawn_type(self):
        def call(name, arguments):
            return {"tool_calls": [{"function": {"name": name, "arguments": json.dumps(arguments)}}]}
        self.assertEqual(replay.first_tool_decision(call("spawn_agent", {"type": "browser"})), "spawn_agent:browser")
        self.assertEqual(replay.first_tool_decision(call("display", {"html": "x"})), "display")
        self.assertEqual(replay.first_tool_decision({"tool_calls": [], "content": "text"}), "no_tool_call")

    def test_panel_counts_decisions_and_isolates_replay_errors(self):
        outcomes = iter([
            {"tool_calls": [{"function": {"name": "spawn_agent", "arguments": '{"type": "browser"}'}}]},
            {"tool_calls": [{"function": {"name": "display", "arguments": "{}"}}]},
            RuntimeError("transport reset"),
        ])

        async def fake_replay(_data):
            outcome = next(outcomes)
            if isinstance(outcome, Exception):
                raise outcome
            return {**outcome, "actual_model": "m"}

        original = replay.replay_generic
        replay.replay_generic = fake_replay
        try:
            panel = replay.asyncio.run(replay.replay_panel(dump(), repeat=3, concurrency=1))
        finally:
            replay.replay_generic = original
        self.assertEqual(panel["decisions"], {"display": 1, "replay_error": 1, "spawn_agent:browser": 1})
        self.assertEqual(panel["actual_models"], ["m"])


if __name__ == "__main__":
    unittest.main()
