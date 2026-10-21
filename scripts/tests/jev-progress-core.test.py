"""Offline regression gate: no secrets, network or production writes."""
from pathlib import Path
import copy
import sys
import tempfile
import unittest
import json
import gzip
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "jev_progress"))
from core import SEED, BINS, FORMATS, request, decode, evaluate, summarize
from optimize import dominates, joint_loss
from weekly import partition, goal_key
from checkpoint import config, validate, export_optimizer, warm_candidates
from core import digest, prepare
import optimize
from learning_curve import analyze


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

    def test_continuation_survives_serialization_without_stale_selection_scores(self):
        original = {'name': 'candidate-11', 'prompt': {**SEED, 'input_format': 'timeline'},
                    'validation': {'metrics': {'trace_macro_mae_pp': 12, 'eta_log_mae': 2}}}
        other = {'name': 'candidate-09', 'prompt': SEED,
                 'validation': {'metrics': {'trace_macro_mae_pp': 20, 'eta_log_mae': 1}}}
        state = {'champion': original['prompt'], 'champion_sha256': digest(original['prompt']),
                 'watermark': '2026-10-21T00:00:00+00:00', 'config': config(),
                 'optimizer': export_optimizer([original, other], original, 12)}
        state['config']['filters']['result_text_chars'] = 1200
        state['config']['search']['iterations_per_run'] = 3
        restored = json.loads(json.dumps(state))
        saved = validate(restored)
        self.assertEqual(saved['filters']['result_text_chars'], 1200)
        self.assertEqual(saved['search']['iterations_per_run'], 3)
        self.assertEqual(restored['optimizer']['next_iteration'], 12)
        candidates = warm_candidates(restored['optimizer'], original['prompt'])
        self.assertEqual(candidates, [{'name': 'candidate-09', 'prompt': SEED}])
        self.assertNotIn('validation_metrics', candidates[0])
        restored['config']['protocol']['model'] = 'changed-model'
        with self.assertRaises(ValueError):
            validate(restored)
        with self.assertRaises(ValueError):
            validate({'champion': SEED})

    def test_new_training_data_does_not_move_validation_boundary(self):
        old = {'example_id': 'validation-old', 'split_group': 'v', 'family_id': 'v',
               'agent_kind': 'normal_root', 'trace_id': 'v'}
        dev = {**old, 'example_id': 'dev-old', 'split_group': 'd', 'family_id': 'd', 'trace_id': 'd'}
        new = {**old, 'example_id': 'new', 'split_group': 'n', 'family_id': 'n', 'trace_id': 'n'}
        frozen = {'validation_groups': ['v'], 'validation_ids': ['validation-old']}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, rows in [('train', [old, dev, new]), ('test', []), ('traces', [])]:
                with gzip.open(root / (name + '.jsonl.gz'), 'wt') as f:
                    for row in rows:
                        f.write(json.dumps(row)+'\n')
            manifest = prepare(root, root / 'run', frozen_split=frozen)
            self.assertEqual(manifest['validation_ids'], ['validation-old'])
            self.assertEqual(set(manifest['train_ids']), {'dev-old', 'new'})

    def test_optimizer_rescores_saved_candidates_instead_of_reusing_old_scores(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data, output = root / 'data', root / 'run'
            data.mkdir()
            dev = {**self.row, 'agent_kind': 'normal_root', 'family_id': 'd', 'split_group': 'd'}
            val = {**dev, 'example_id': 'val', 'family_id': 'v', 'split_group': 'v'}
            for name, rows in [('train', [dev, val]), ('test', []), ('traces', [self.trace])]:
                with gzip.open(data / (name + '.jsonl.gz'), 'wt') as f:
                    for row in rows:
                        f.write(json.dumps(row)+'\n')
            prepare(data, output, {'validation_groups': ['v'], 'validation_ids': ['val']})
            seed_result = {'metrics': {'failed': 0, 'trace_macro_mae_pp': 10, 'eta_log_mae': 2}, 'rows': []}
            for split in ('train', 'validation'):
                (output / (split + '-baseline.json')).write_text(json.dumps(seed_result))
            old_prompt = {**SEED, 'progress': 'Retained candidate'}
            warm = {'next_iteration': 12, 'frontier': [digest(old_prompt)], 'candidates': [
                {'name': 'candidate-09', 'prompt': old_prompt,
                 'validation_metrics': {'trace_macro_mae_pp': 0.01, 'eta_log_mae': 0.01}}]}
            warm_path = root / 'warm.json'
            warm_path.write_text(json.dumps(warm))
            worse_now = {'metrics': {'failed': 0, 'trace_macro_mae_pp': 30, 'eta_log_mae': 5}, 'rows': []}
            with patch.object(sys, 'argv', ['optimize.py', '--dataset', str(data), '--output', str(output),
                                           '--warm-start', str(warm_path), '--start-at', '12', '--iterations', '11']), \
                    patch.object(optimize, 'evaluate', return_value=worse_now) as evaluator:
                optimize.main()
            self.assertEqual(evaluator.call_count, 2)
            self.assertEqual(json.loads((output/'winner.json').read_text())['name'], 'seed')
            self.assertEqual(json.loads((output/'optimizer-state.json').read_text())['next_iteration'], 12)

    def test_late_drop_requires_a_plateau_then_a_material_improvement(self):
        points = [{'iteration': i, 'joint_loss': v} for i,v in enumerate([1.1,1.2,1.05,1.03,.90],12)]
        report = analyze(points)
        self.assertEqual(report['late_drops'][0]['iteration'], 16)
        self.assertAlmostEqual(report['late_drops'][0]['drop_from_plateau'], .1)
        steady = [{'iteration': i, 'joint_loss': v} for i,v in enumerate([.99,.95,.9,.85,.8])]
        self.assertEqual(analyze(steady)['late_drops'], [])


if __name__ == "__main__":
    unittest.main()
