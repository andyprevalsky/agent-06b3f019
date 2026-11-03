"""Offline regression for `run-bench full`: last-3-pass cloud tasks at k copies, capacity-bound by relevance."""
from __future__ import annotations

import io
import json
import runpy
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FULL = runpy.run_path(str(ROOT / "scripts/cloudbench-full-selection.py"))


def attempt(task, passed, stamp):
    return {"task": task, "passed": passed, "timestamp": f"2026-10-2{stamp}T00:00:00+00:00"}


class FullSelectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.catalog = root / "tasks.json"
        self.attempts = root / "task_attempts.jsonl"
        self.catalog.write_text(json.dumps([
            {"name": "smoke-chat", "tags": ["smoke"], "deploy_category": "chat"},
            {"name": "pay-shop", "tags": ["payment"], "deploy_category": "payment"},
            {"name": "sms-open", "tags": ["sms"], "deploy_category": "sms"},
            {"name": "flaky", "tags": [], "deploy_category": "chat"},
            {"name": "short-history", "tags": [], "deploy_category": "chat"},
            {"name": "local-gate", "tags": ["local-only"], "deploy_category": "chat"},
            {"name": "unfinished", "status": "incomplete", "deploy_category": "chat"},
            {"name": "prod-only", "production_only": True, "deploy_category": "payment"},
        ]))
        rows = []
        for task in ("smoke-chat", "pay-shop", "sms-open", "local-gate", "unfinished", "prod-only"):
            rows += [attempt(task, True, d) for d in (1, 2, 3)]
        rows += [attempt("pay-shop", False, 0)]  # an older failure before the last 3 passes
        rows += [attempt("flaky", True, 1), attempt("flaky", False, 2), attempt("flaky", True, 3)]
        rows += [attempt("short-history", True, 1), attempt("short-history", True, 2)]
        self.attempts.write_text("".join(json.dumps(r) + "\n" for r in rows))
        # The sharded operator's cloud-root rule refuses rootless SMS tasks.
        self.admitted = {"smoke-chat", "pay-shop", "flaky", "short-history", "local-gate", "unfinished", "prod-only"}

    def tearDown(self):
        self.tmp.cleanup()

    def select(self, free_slots, changed=(), runs=2, copy_cap=70):
        report = io.StringIO()
        names = FULL["select_full"](self.catalog, self.attempts, runs, list(changed), lambda: free_slots, report,
                                    lambda: self.admitted, lambda: copy_cap)
        return names, report.getvalue()

    def test_selects_every_cloud_task_whose_last_three_runs_passed(self):
        names, report = self.select(1000)
        self.assertEqual(sorted(names), ["pay-shop", "smoke-chat"])
        self.assertIn("2 cloud task(s) passed their last 3 runs; k=2; capacity 2", report)
        for excluded in ("local-gate", "unfinished", "prod-only", "sms-open"):
            self.assertIn(excluded, report)

    def test_capacity_keeps_the_tasks_most_relevant_to_the_changes(self):
        coordinator = runpy.run_path(str(ROOT / "scripts/cloudbench-shard-coordinator.py"))
        one = coordinator["plan_shards"](["x"], 2)
        slots_for_one = coordinator["capacity_demand"](one["copies"], one["controllers"])
        changed = ["agents/domains/request_payment_card/handler.py", "back-end/src/domains/agentcard/x.ts"]
        names, report = self.select(slots_for_one, changed)
        self.assertEqual(names, ["pay-shop"])
        self.assertIn("capacity binds; kept the 1 most relevant to 2 changed file(s)", report)
        two = coordinator["plan_shards"](["x", "y"], 2)
        names, _ = self.select(coordinator["capacity_demand"](two["copies"], two["controllers"]), changed)
        self.assertEqual(names, ["pay-shop", "smoke-chat"])  # relevance first, then smoke

    def test_capacity_accounts_for_k_copies(self):
        coordinator = runpy.run_path(str(ROOT / "scripts/cloudbench-shard-coordinator.py"))
        plan = coordinator["plan_shards"](["a", "b"], 1)
        slots = coordinator["capacity_demand"](plan["copies"], plan["controllers"])
        self.assertEqual(len(self.select(slots, runs=1)[0]), 2)
        self.assertLess(len(self.select(slots, runs=2)[0]), 2)

    def test_provider_copy_cap_binds_before_free_slots(self):
        changed = ["agents/domains/request_payment_card/handler.py"]
        names, report = self.select(1000, changed, runs=2, copy_cap=3)
        self.assertEqual(names, ["pay-shop"])  # 2 tasks x 2 copies would exceed 3 concurrent benches
        self.assertIn("capacity 1 task(s) (3 concurrent benches provider cap, 1000 free Machine slots)", report)
        self.assertEqual(len(self.select(1000, runs=2, copy_cap=4)[0]), 2)

    def test_no_capacity_fails_closed(self):
        with self.assertRaises(SystemExit):
            self.select(0)


if __name__ == "__main__":
    unittest.main()
