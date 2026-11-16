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

    def test_browser_panel_replays_the_recorded_browser_call(self):
        seen = []

        async def fake_browser(data, *, exact):
            seen.append((data["call_site"], exact))
            return {"tool_calls": [{"name": "recover_from_challenge", "arguments": "{}"}], "actual_model": "m"}

        async def forbidden_generic(_data):
            raise AssertionError("browser_use panels must replay through replay_browser_use")

        original_browser, original_generic = replay.replay_browser_use, replay.replay_generic
        replay.replay_browser_use, replay.replay_generic = fake_browser, forbidden_generic
        try:
            panel = replay.asyncio.run(
                replay.replay_panel({"call_site": "browser_use_step_6", "messages": []}, repeat=2, concurrency=1)
            )
        finally:
            replay.replay_browser_use, replay.replay_generic = original_browser, original_generic
        self.assertEqual(panel["decisions"], {"recover_from_challenge": 2})
        self.assertEqual(seen, [("browser_use_step_6", True), ("browser_use_step_6", True)])

    def test_current_tools_swaps_only_the_tool_contract_and_reports_changes(self):
        current = [
            {"name": "wait", "description": "same", "input_schema": {"type": "object"}},
            {"name": "recover_from_challenge", "description": "new", "input_schema": {"type": "object"}},
        ]
        recorded = [
            {"name": "wait", "description": "same", "input_schema": {"type": "object"}},
            {"name": "recover_from_challenge", "description": "old", "input_schema": {"type": "object"}},
        ]
        messages = [{"role": "user", "content": "goal"}]
        data = {
            "call_site": "browser_use_step_5",
            "messages": messages,
            "tools": recorded,
            "config": {
                "available_actions": ["wait", "recover_from_challenge"],
                "requested_params": {"tools": recorded},
            },
        }
        built_for = []
        original = replay.build_browser_use_tools
        replay.build_browser_use_tools = lambda actions: built_for.append(list(actions)) or current
        try:
            changed = replay.apply_current_browser_tools(data)
        finally:
            replay.build_browser_use_tools = original
        self.assertEqual(changed, ["recover_from_challenge"])
        self.assertEqual(built_for, [["wait", "recover_from_challenge"]])
        self.assertIs(data["tools"], current)
        self.assertIs(data["config"]["requested_params"]["tools"], current)
        self.assertIs(data["messages"], messages)
        with self.assertRaises(SystemExit):
            replay.apply_current_browser_tools({"call_site": "execute_loop", "messages": []})

    def test_expectations_fail_below_minimum_and_reject_malformed_specs(self):
        decisions = {"recover_from_challenge": 1, "wait": 7}
        unmet = replay.unmet_expectations
        self.assertEqual(unmet(decisions, ["recover_from_challenge:6"]), ["recover_from_challenge: 1 < 6"])
        self.assertEqual(unmet(decisions, ["wait:7", "recover_from_challenge:1"]), [])
        self.assertEqual(unmet(decisions, ["spawn_agent:browser:1"]), ["spawn_agent:browser: 0 < 1"])
        with self.assertRaises(SystemExit):
            replay.unmet_expectations(decisions, ["recover_from_challenge"])


if __name__ == "__main__":
    unittest.main()
