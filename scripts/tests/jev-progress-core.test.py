"""Offline regression gate: no secrets, network or production writes."""
from pathlib import Path
import copy
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "jev_progress"))
from core import SEED, BINS, FORMATS, request, decode, evaluate, summarize
from optimize import dominates, joint_loss
from weekly import partition, goal_key


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.trace = {"trace_id": "a", "kind": "normal_root", "goal": "Read and report",
                      "output_schema": {"type": "string"}, "events": [
                          {"role": "assistant", "calls": [{"id": "t", "name": "read"}], "timestamp": "2026-01-01T00:00:00Z"},
                          {"role": "tool", "text": "visible", "call_id": "t"},
                          {"role": "assistant", "calls": [{"id": "c", "name": "attempt_completion"}], "text": "SECRET_FUTURE"},
                          {"role": "tool", "call_id": "c", "status": "FINISHED", "timestamp": "2026-01-01T00:01:00Z"}],
                      "terminal_receipt": {"password": "SECRET_LABEL"}, "total_batches": 2}
        self.row = {"example_id": "row", "trace_id": "a", "cutoff_event_index": 1,
                    "target": {"observed_batches": 1, "remaining_batches": 1, "batch_progress": .5}}
        self.raw = {"model": "jev-1.13.0", "answers": {
            "remaining_batches": {"probabilities": {str(i): float(i == 1) for i in range(len(BINS))}},
            "eta": {"choice": "1m"}}, "usage": {"input_tokens": 10, "output_tokens": 3}}

    def test_request_cannot_see_future_or_labels(self):
        body = request(self.row, self.trace, SEED)
        self.assertNotIn("SECRET", str(body))
        self.assertNotIn("target", body["state"])
        changed = copy.deepcopy(self.row)
        changed["target"] = {"batch_progress": .99, "remaining_batches": 99}
        self.assertEqual(body, request(changed, self.trace, SEED))

    def test_distribution_decoding_and_model_fence(self):
        row = decode(self.raw, self.row, self.trace)
        self.assertEqual(row["predicted_progress"], .5)
        self.assertEqual(row["progress_error"], 0)
        raw = copy.deepcopy(self.raw)
        raw["model"] = "another-model"
        with self.assertRaises(ValueError):
            decode(raw, self.row, self.trace)

    def test_every_input_format_is_prefix_only(self):
        for fmt in FORMATS:
            prompt = {**SEED, 'input_format': fmt}
            before = request(self.row, self.trace, prompt)
            trace = copy.deepcopy(self.trace)
            trace['events'][2:]=[{'role': 'assistant', 'calls': [], 'text': 'DIFFERENT_FUTURE'}]
            trace['total_batches']=999
            self.assertEqual(before, request(self.row, trace, prompt))
            self.assertNotIn('SECRET', str(before))
        with self.assertRaises(ValueError):
            request(self.row, self.trace, {**SEED, 'input_format': 'untrusted'})
        raw = copy.deepcopy(self.raw)
        raw["answers"]["remaining_batches"]["probabilities"]["1"] = -1
        with self.assertRaises(ValueError):
            decode(raw, self.row, self.trace)

    def test_resume_cache_and_prompt_change(self):
        calls = []
        def transport(body, key):
            calls.append(body)
            return self.raw, .1
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for _ in range(2):
                result = evaluate([self.row], {"a": self.trace}, SEED, root, transport=transport)
                self.assertEqual(result["metrics"]["valid"], 1)
            self.assertEqual(len(calls), 1)
            evaluate([self.row], {"a": self.trace}, {**SEED, "progress": "Changed"}, root, transport=transport)
            self.assertEqual(len(calls), 2)

    def test_failures_remain_in_denominator(self):
        row = {**decode(self.raw, self.row, self.trace), "ok": True}
        metric = summarize([row, {"ok": False}], 2)
        self.assertEqual(metric["failed"], 1)
        self.assertEqual(metric["progress_within_10pp"], .5)

    def test_joint_objective_and_pareto_preserve_time_tradeoff(self):
        base = {"trace_macro_mae_pp": 20, "eta_log_mae": 2, "failed": 0}
        progress_gain = {"trace_macro_mae_pp": 10, "eta_log_mae": 2, "failed": 0}
        time_gain = {"trace_macro_mae_pp": 20, "eta_log_mae": 1, "failed": 0}
        self.assertEqual(joint_loss(progress_gain, base), joint_loss(time_gain, base))
        self.assertFalse(dominates(progress_gain, time_gain))
        self.assertFalse(dominates(time_gain, progress_gain))
        self.assertTrue(dominates(time_gain, base))
        self.assertEqual(joint_loss({**time_gain, "failed": 1}, base), float("inf"))

    def test_fresh_holdout_keeps_families_and_goals_together(self):
        state = {'split_salt': '00'*32, 'goals': {}, 'seen_families': []}
        traces = [{'family_id': str(i), 'goal': goal} for i, goal in enumerate(['same', ' SAME ', 'new'])]
        sealed, train = partition(traces, state)
        self.assertFalse({goal_key(t) for t in sealed} & {goal_key(t) for t in train})
        repeated = [{'family_id': 'fresh-family', 'goal': 'same'}]
        again_test, again_train = partition(repeated, state)
        self.assertEqual(again_test + again_train, [])

    def test_previously_sealed_goals_never_enter_training(self):
        t = {'family_id': 'fresh', 'goal': 'private holdout'}
        state = {'split_salt': '00'*32, 'goals': {goal_key(t): 'sealed'}, 'seen_families': []}
        sealed, train = partition([t], state)
        self.assertEqual(sealed + train, [])


if __name__ == "__main__":
    unittest.main()
