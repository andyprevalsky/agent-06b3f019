#!/usr/bin/env python3
"""The CLI benchmark scorecard renders only recorded artifacts and enforces FORMAT v8.

Golden text renders cover fleet, campaign and sharded runs; set UPDATE_GOLDEN=1
to rewrite them after an intentional presentation change.
"""

import io
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
CARD = runpy.run_path(str(ROOT / "scripts/cloudbench-scorecard.py"))
LEDGER = runpy.run_path(str(ROOT / "scripts/cloudbench_experiments.py"))
AUDIT = runpy.run_path(str(ROOT / "scripts/cloudbench-native-release-audit.py"))
GOLDEN = ROOT / "scripts/tests/fixtures/scorecard"
T0 = 1792351732.0  # Oct 18 2026, 12:28:52 PM PDT
NOW = T0 + 3600


def write(path: Path, value) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value))
    return path


def card(run_id, tasks, *, window="480", cost=True):
    return {"run_id": run_id, "timestamp": "2026-10-18T19:28:52+00:00", "status": "passed",
            "code": "HEAD@126b82622 (pinned)",
            "cost": {"agents_llm_usd": 0.5 if cost else None, "wmh_grounding_usd": None, "infra_usd": None,
                     "total_usd": 0.5, "fast_cache_hit_rate": 0.8 if cost else None},
            "tasks": {"total": len(tasks)}, "per_task": tasks,
            "execution_provenance": {"base_sha": "1387ae608e7cfb8e3f0a876daae92093f503b465",
                                     "config": {"values": {"benchmark_wall_clock_backstop_seconds": window}}}}


def task(name, status, *, duration=120.0, cost=0.25, reason=None, stage="released"):
    return {"name": name, "status": status, "duration_s": duration, "cost_usd": cost,
            "failure_reason": reason, "lifecycle_stage": stage, "agent_id": "8041de66-1bd1-4fe9-bb78-93c12c51e16c"}


def job(index, status, verdict, infra, *, run_id=None, fleet=None, pid=None, attempts=1, wall=600.0, released=True):
    jid = f"r001-j{index:04d}"
    tries = [dict(attempt=n, status=status if n == attempts else "failed", finished_at="2026-10-18T20:00:00Z",
                  infra_failure=infra if n == attempts else True, run_id=run_id if n == attempts else None,
                  controller_pid=pid) for n in range(1, attempts + 1)] if status in ("passed", "failed") else (
        [dict(attempt=1, status="running")] if status == "running" else [])
    return dict(job_id=jid, task=f"task-{index}", run=1, status=status, task_status=verdict, infra_failure=infra,
                run_id=run_id, fleet_dir=fleet, controller_pid=pid, attempts=tries, wall_clock_seconds=wall,
                started_at="2026-10-18T19:40:00+00:00", finished_at="2026-10-18T19:50:00+00:00" if status in ("passed", "failed") else None,
                resources_released=released if status in ("passed", "failed") else None,
                lifecycle_verified=released if status in ("passed", "failed") else None)


class Fixtures:
    def __init__(self, base: Path):
        self.base = base
        self.ledger = base / "ledger.jsonl"

    def fleet(self) -> Path:
        run = self.base / "20261018-192852-4242"
        write(run / "_batch/report-card.json", card(run.name, [
            task("alpha", "passed"), task("beta", "failed", reason="Timeout after 480s (wall-clock backstop=480s) | Agent status: PAUSED")]))
        write(run / "_batch/lifecycle.json", {"run_id": run.name, "status": "verified", "controller_exit_code": 1,
                                             "hub_publication_failed": False})
        for name, end in (("alpha", T0 + 700), ("beta", T0 + 900)):
            write(run / name / "bench-e2e.started-epoch", str(T0))
            write(run / name / "bench-e2e.finished-epoch", str(end))
        write(run / "teardown-ownership/provider-teardown-verified.epoch", str(T0 + 960))
        LEDGER["record"]("launch", run.name, ledger=self.ledger, goal="fleet-goal", slice="alpha +1", kind="fleet",
                         run_dir=str(run), triggered_at=T0)
        return run

    def campaign(self) -> Path:
        directory = self.base / "campaigns/campaign-20261018-192852-7"
        fleet = self.base / "fleet/runs/20261018-193000-11"
        write(fleet / "_batch/report-card.json", card(fleet.name, [task("task-2", "failed", reason="Expected tool 'spawn_browser_agent' not found in messages")]))
        jobs = [job(1, "passed", "PASSED", False), job(2, "failed", "FAILED", False, run_id=fleet.name, fleet=str(fleet)),
                job(3, "failed", "INFRA_ERROR", True, attempts=2, released=True), job(4, "running", None, None),
                job(5, "queued", None, None)]
        write(directory / "summary.json", {"campaign_id": directory.name, "started_at": "2026-10-18T19:28:52+00:00",
                                           "e2e_started_at_epoch": T0, "status": "running", "runs": 1, "task_count": 5,
                                           "total_jobs": 5, "jobs": jobs})
        LEDGER["record"]("launch", directory.name, ledger=self.ledger, goal="campaign-goal", slice="mixed5",
                         kind="campaign", run_dir=str(directory), triggered_at=T0)
        return directory

    def sharded(self, *, result=True, audit=True, live=False) -> Path:
        admission = self.base / "original600-1792351732378699991"
        write(admission / "coordination.json", {
            "schema": "original600-shard-coordination-v1", "controllers": 2, "scheduled_total": 4,
            "started_at": T0 + 12, "released_at": T0 + 600, "finished_at": None if live else T0 + 2000,
            "abort_reason": None, "terminate_reason": None,
            "shards": {"0": {"out": str(admission / "shard-00/run")}, "1": {"out": str(admission / "shard-01/run")}}})
        for index in (0, 1):
            shard = admission / f"shard-{index:02d}"
            write(shard / "attempt-start.safe.json", {"started_at_epoch": T0, "source_ref": "126b82622ed84875512852fcaf6a7afe1b4b5130",
                                                      "task_ref": "1387ae608e7cfb8e3f0a876daae92093f503b465"})
            progress = {"combos": [["passed", "PASSED", False, 1], ["running", None, None, 1]], "jobs": 2,
                        "terminal_attempts": 1, "infra_attempts": 0,
                        "reasons": [["AGENT FAIL", "Timeout after 480s (wall-clock backstop=480s)", 1]] if index else []}
            write(shard / "run/shard-status.json", {"schema": "original600-shard-status-v1", "state": "LIVE",
                                                    "infra": {"infra_true": 0, "unique_jobs": 2, "progress": progress}})
            if not live:
                write(shard / "run/terminal.json", {"status": "CONTROLLER_RELEASE_VERIFIED", "machine": f"8744150b0d72{index:02d}"})
                write(shard / "run/export/disposable-export.verified.json", "{}")
        write(admission / "hub-group/hub-group.json", {"run_group": {"members": [
            {"member_id": f"r001-j{i:04d}", "name": f"task-{i}", "run_number": 1} for i in range(1, 5)]}})
        if result and not live:
            rows = CARD["compact_rows"]({"jobs": [job(1, "passed", "PASSED", False), job(2, "failed", "FAILED", False),
                                                  job(3, "failed", "FAILED", False), job(4, "failed", None, None, pid=99, released=False)]},
                                        {"20261018-1-99": card("20261018-1-99", [task("task-4", "passed", stage="teardown")])})
            write(admission / "result.json", {"scheduled_total": 4, "observed_jobs": 4, "missing_jobs": 0,
                                              "hub_group_final_published": True, "jobs": rows})
        if audit and not live:
            write(admission / "native-release-audit.json", AUDIT["audit"](
                [{"id": "abcdefabcdef01", "name": "unrelated", "state": "started"}], app="navi-whisper-lux-bench",
                guest_names={"cloudbench-a", "cloudbench-b"}, guest_ids={"0123456789abcd"},
                controllers={"8744150b0d7200"}, exports=2, now=T0 + 2100))
        LEDGER["record"]("launch", "original600-1792319287448456235", ledger=self.ledger, goal="original600",
                         slice="run600c", kind="sharded", run_dir=str(self.base / "absent"), triggered_at=T0 - 32000,
                         scheduled_total=600)
        LEDGER["record"]("end", "original600-1792319287448456235", ledger=self.ledger, goal="original600",
                         ended_at=T0 - 27000, state="FAILED",
                         outcome={"task_status": {"PASSED": 90, "FAILED": 484, "INFRA_ERROR": 14, "UNKNOWN": 12},
                                  "infra_failures": 14})
        LEDGER["record"]("launch", admission.name, ledger=self.ledger, goal="original600", slice="polar4",
                         kind="sharded", run_dir=str(admission), triggered_at=T0, scheduled_total=4)
        return admission

    def barrier_abort(self, *, shards=3, scheduled=70) -> Path:
        """Mirrors original600-1792402040642867509: operator SIGTERM at the launch barrier, no
        terminal.json, controllers released afterwards by the exact cleanup helper's canonical receipts."""
        admission = self.base / "original600-1792402040642867509"
        outs = {str(i): {"out": str(admission / f"shard-{i:02d}/run"), "pid": 347865 + i} for i in range(shards)}
        write(admission / "coordination.json", {
            "schema": "original600-shard-coordination-v1", "controllers": shards, "scheduled_total": scheduled,
            "started_at": T0 + 10, "released_at": None, "aborted_at": T0 + 1072, "abort_reason": "operator SIGTERM",
            "terminated_at": T0 + 1072, "terminate_reason": "operator SIGTERM", "finished_at": T0 + 3124,
            "infra_true": 0, "exit_codes": {str(i): -9 for i in range(shards)}, "shards": outs})
        for i in range(shards):
            run = admission / f"shard-{i:02d}/run"
            mid, vid = f"80e9037b3942{i:02d}", f"vol_vxmzjq6z13mwl9{i:02d}"
            write(admission / f"shard-{i:02d}/attempt-start.safe.json", {"started_at_epoch": T0, "source_ref": "7441b41f4c56a24f350303fa31bfcf698e2519ff"})
            write(run / "shard-status.json", {"schema": "original600-shard-status-v1", "state": "NOT_PUBLISHED",
                                              "barrier": None, "infra": None, "machine": mid})
            write(run / "global-abort.json", {"reason": "operator SIGTERM", "release_id": "354e4f818c1ed72f00480145"})
            write(run / "export/disposable-export.verified.json", "{}")
            write(run / "export/disposable-controller.ownership.json", {"machine": {"id": mid}, "volume": {"id": vid}})
            write(run / "export/workspace-volume.ownership.json", {"volume_id": vid})
            write(run / "export/disposable-controller.release.json", {"machine_deleted": True, "machine_id": mid,
                                                                     "volume_disposition": "pending_destroy", "volume_id": vid})
        write(admission / "result.json", {"campaign_status": {}, "jobs": [], "observed_jobs": 0, "missing_jobs": scheduled,
                                          "scheduled_total": scheduled, "task_status": {}, "infra_failures": 0,
                                          "hub_group_final_published": True})
        LEDGER["record"]("launch", admission.name, ledger=self.ledger, goal="70-tasks", slice="70-tasks",
                         kind="sharded", run_dir=str(admission), triggered_at=T0, scheduled_total=scheduled)
        return admission


def render(path, fixtures, **kw):
    return CARD["build"](path, ledger=fixtures.ledger, now=NOW, **kw)


class Scorecard(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="scorecard-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.f = Fixtures(self.tmp)

    def golden(self, name, value):
        text = value.replace(str(self.tmp), "<tmp>")
        path = GOLDEN / f"{name}.golden.txt"
        if os.environ.get("UPDATE_GOLDEN") == "1":
            write(path, text)
        self.assertEqual(text, path.read_text(), f"golden {name} changed; rerun with UPDATE_GOLDEN=1 if intentional")

    def valid(self, data):
        document = CARD["render_html"](data)
        self.assertEqual(CARD["validate_html"](document), [])
        return document

    def test_fleet_golden_and_html(self):
        data = render(self.f.fleet(), self.f)
        self.golden("fleet", CARD["render_text"](data))
        document = self.valid(data)
        self.assertIn("🧪 Experiment #1", document)
        self.assertEqual(data["experiment"]["state"], "COMPLETE")
        self.assertEqual(data["experiment"]["ended_at"], T0 + 960, "end comes from the producer teardown epoch")

    def test_campaign_golden_progress_and_retry_attempts(self):
        data = render(self.f.campaign(), self.f)
        self.golden("campaign", CARD["render_text"](data))
        exp = data["experiment"]
        self.assertEqual(exp["progress"], {"queued": 1, "in_progress": 1, "completed": 3, "unobserved": 0})
        self.assertEqual((exp["terminal_attempts"], exp["infra_attempts"], exp["infra_jobs"]), (4, 2, 1),
                         "retained retry attempts stay in the infra denominator; the job counts once")
        self.assertEqual(exp["state"], "RUNNING")
        self.assertEqual(exp["reasons"][0][1], "Expected tool 'spawn_browser_agent' not found in messages")
        self.valid(data)

    def test_sharded_golden_audit_and_history(self):
        data = render(self.f.sharded(), self.f)
        self.golden("sharded", CARD["render_text"](data))
        exp = data["experiment"]
        self.assertEqual(data["number"], 2)
        self.assertEqual(exp["outcomes"]["PASS"], 2, "an evaluated card verdict survives a later release failure")
        released = next(i for i in exp["lifecycle"] if i["label"].startswith("Guests released"))
        self.assertEqual((released["state"], released["label"]), ("ok", "Guests released (native audit)"))
        self.assertEqual([h["label"] for h in data["history"]], ["polar4", "run600c"])
        self.assertEqual(data["history"][1]["outcomes"]["INFRA"], 14)
        self.valid(data)

    def test_native_audit_presence_and_absence(self):
        admission = self.f.sharded(audit=False)
        no_audit = render(admission, self.f)["experiment"]
        item = next(i for i in no_audit["lifecycle"] if i["label"].startswith("Guests released"))
        self.assertEqual((item["state"], item["label"]), ("warn", "Guests released"))
        write(admission / "native-release-audit.json", AUDIT["audit"](
            [{"id": "0123456789abcd", "name": "cloudbench-a", "state": "stopped"}], app="app",
            guest_names={"cloudbench-a"}, guest_ids={"0123456789abcd"}, controllers=set(), exports=2, now=T0 + 2100))
        present = render(admission, self.f)["experiment"]
        item = next(i for i in present["lifecycle"] if i["label"].startswith("Guests released"))
        self.assertEqual(item["state"], "fail")
        self.assertIn("cloudbench-a", item["detail"])

    def test_native_audit_retained_owner_without_guest_names_is_not_hidden(self):
        admission = self.f.sharded(audit=False)
        write(admission / "native-release-audit.json", AUDIT["audit"](
            [], app="app", guest_names=set(), guest_ids=set(), controllers=set(), exports=2, now=T0 + 2100,
            retained_owners=["0123456789abcdef0123"]))
        item = next(i for i in render(admission, self.f)["experiment"]["lifecycle"] if i["label"].startswith("Guests released"))
        self.assertEqual((item["state"], item["label"]), ("fail", "Guests released (native audit)"))
        self.assertIn("retained owners: 0123456789ab", item["detail"])

    def test_native_audit_fails_closed_without_identities_or_every_shard_export(self):
        unchecked = AUDIT["audit"]([], app="app", guest_names=set(), guest_ids=set(), controllers=set(), exports=0, now=T0)
        self.assertFalse(unchecked["released"], "an audit that checked no identity never certifies release")
        partial = AUDIT["audit"]([], app="app", guest_names={"cloudbench-a"}, guest_ids=set(), controllers=set(),
                                 exports=1, shards=2, now=T0)
        self.assertFalse(partial["released"], "a shard without its verified export never certifies release")
        self.assertTrue(AUDIT["audit"]([], app="app", guest_names={"cloudbench-a"}, guest_ids=set(), controllers=set(),
                                       exports=2, shards=2, now=T0)["released"])
        admission = self.f.sharded(audit=False)
        (admission / "shard-01/run/export/disposable-export.verified.json").unlink()

        class Api:
            def api(self, method, path, timeout):
                return []
        result = AUDIT["run"](admission, Api(), "app")
        self.assertEqual((result["present"], result["released"], result["checked"]["expected_shards"]), ([], False, 2))
        write(admission / "native-release-audit.json", AUDIT["audit"](
            [], app="app", guest_names={"cloudbench-a"}, guest_ids=set(), controllers=set(), exports=1, shards=2,
            now=T0 + 2100))
        item = next(i for i in render(admission, self.f)["experiment"]["lifecycle"] if i["label"].startswith("Guests released"))
        self.assertNotEqual(item["state"], "ok", "an incomplete native audit renders no verified release")

    def controllers_released(self, admission):
        return next(i for i in render(admission, self.f)["experiment"]["lifecycle"] if i["label"] == "Controllers released")

    def test_canonical_release_receipts_count_controllers_released(self):
        admission = self.f.barrier_abort()
        item = self.controllers_released(admission)
        self.assertEqual(item["state"], "ok", item)
        self.assertTrue(item["detail"].startswith("3/3 "), item)
        self.assertIn("pending_destroy", item["detail"])
        export = admission / "shard-01/run/export"
        bad = {"machine_deleted": False}, {"volume_disposition": "attached"}, {"machine_id": "abcdefabcdef01"}, {"volume_id": "vol_other"}
        for change in bad:
            receipt = json.loads((export / "disposable-controller.release.json").read_text())
            original = dict(receipt)
            write(export / "disposable-controller.release.json", dict(receipt, **change))
            item = self.controllers_released(admission)
            self.assertEqual((item["state"], item["detail"][:4]), ("pending", "2/3 "), f"{change} must not certify release")
            write(export / "disposable-controller.release.json", original)
        (export / "disposable-controller.ownership.json").unlink()
        self.assertTrue(self.controllers_released(admission)["detail"].startswith("2/3 "),
                        "a receipt without the exact controller ownership record certifies nothing")

    def test_runner_pre_supervisor_release_terminal_counts_controllers_released(self):
        # The runner now ends a startup that never published a supervisor with its own terminal.
        admission = self.f.barrier_abort()
        for shard in ("00", "01", "02"):
            write(admission / f"shard-{shard}/run/terminal.json",
                  {"status": "FAILED_BEFORE_SUPERVISOR_RELEASED", "supervisor_state": "NOT_PUBLISHED", "gate_exit_code": 1,
                   "release": {"machine_deleted": True, "volume_disposition": "pending_destroy"}, "benchmark_success_inferred": False})
        item = self.controllers_released(admission)
        self.assertEqual((item["state"], item["detail"][:4]), ("ok", "3/3 "), item)
        self.assertIn("FAILED_BEFORE_SUPERVISOR_RELEASED", item["detail"])

    def test_barrier_abort_before_release_renders_never_started_queue(self):
        admission = self.f.barrier_abort()
        data = render(admission, self.f)
        exp = data["experiment"]
        self.assertEqual(exp["progress"], {"queued": 70, "in_progress": 0, "completed": 0, "unobserved": 0})
        self.assertTrue(exp["never_started"])
        text = CARD["render_text"](data)
        self.assertIn("QUEUED 70 · IN_PROGRESS 0 · COMPLETED 0/70 · never started", text)
        self.assertNotIn("QUEUED / IN_PROGRESS / COMPLETED UNMEASURED", text)
        self.assertIn("never started", self.valid(data))
        # Any evidence that the barrier could have released keeps the queue UNMEASURED.
        write(admission / "shard-02/run/global-release.json", {"release_id": "354e4f818c1ed72f00480145"})
        self.assertIsNone(render(admission, self.f)["experiment"]["progress"])
        (admission / "shard-02/run/global-release.json").unlink()
        (admission / "shard-02/run/global-abort.json").unlink()
        self.assertIsNone(render(admission, self.f)["experiment"]["progress"], "undelivered abort is not proof")

    def test_headline_progress_precedes_exact_failure_counts(self):
        data = render(self.f.campaign(), self.f)
        document = self.valid(data)
        kpis = document.split('data-section="kpis"', 1)[1].split('</section>', 1)[0]
        labels = re.findall(r'<div class="k">([^<]+)</div>', kpis)
        self.assertEqual(labels[:3], ["QUEUED", "IN_PROGRESS", "COMPLETED"])
        self.assertNotIn("%", kpis)
        outcomes = document.split('data-section="outcomes"', 1)[1].split('</section>', 1)[0]
        self.assertLess(outcomes.index("PASS"), outcomes.index("HARNESS FAILURE"))
        self.assertLess(outcomes.index("HARNESS FAILURE"), outcomes.index("INFRA FAILURE"))
        self.assertIn("INFRA FAILURE 1", outcomes)
        self.assertLess(outcomes.index("INFRA FAILURE"), outcomes.index("AGENT FAILURE"))
        text = CARD["render_text"](data)
        self.assertIn("PASS 1 · HARNESS FAILURE 0 · INFRA FAILURE 1", text)
        self.assertEqual(data["experiment"]["progress"], {"queued": 1, "in_progress": 1, "completed": 3, "unobserved": 0})

    def test_experiments_per_day_remains_numeric_while_warming(self):
        admission = self.f.barrier_abort()
        text = CARD["render_text"](render(admission, self.f))
        self.assertIn("24.0 experiments/day · 1 launch / 0.04 d · warming 1h00m", text)
        self.assertNotIn("rate after 1 d", text)
        self.assertIn("24.0 experiments/day", self.valid(render(admission, self.f)))
        later = CARD["build"](admission, ledger=self.f.ledger, now=T0 + 2 * 86400)
        self.assertIn("0.5 experiments/day · 1 launch / 2.00 d", CARD["render_text"](later))

    def test_unpublished_hub_group_names_its_receipt(self):
        admission = self.f.sharded()
        result = json.loads((admission / "result.json").read_text())
        reason = ("HubVisibilityError: benchmark Hub upload failed: HTTP Error 400; "
                  'response_metadata={"status": 400, "x_request_id": "683e826b152f"}')
        write(admission / "result.json", {**result, "hub_group_final_published": False,
                                          "hub_group_final_error": reason})
        item = next(i for i in render(admission, self.f)["experiment"]["lifecycle"]
                    if i["label"] == "Hub group publication")
        self.assertEqual(item["state"], "warn")
        self.assertEqual(item["detail"], "final group NOT published: " + reason[:160])

    def test_sharded_live_counters_render_running(self):
        data = render(self.f.sharded(live=True), self.f)
        exp = data["experiment"]
        self.assertEqual(exp["state"], "RUNNING")
        self.assertEqual(exp["rows_source"], "live shard-status counters")
        self.assertEqual(exp["progress"], {"queued": 0, "in_progress": 2, "completed": 2, "unobserved": 0})
        self.assertEqual(exp["reasons"], [["AGENT FAIL", "Timeout after 480s (wall-clock backstop=480s)", 1]])
        self.assertEqual(data["since"], {"state": "RUNNING"})
        document = self.valid(data)
        self.assertIn("RUNNING", document)

    def test_finished_shards_without_result_keep_terminal_clock_and_unknown_counts(self):
        admission = self.f.sharded(result=False)
        before = {str(p): p.read_bytes() for p in admission.rglob("*.json")}
        exp = CARD["load_sharded"](admission, deep=False)
        self.assertEqual(exp["state"], "INCOMPLETE")
        self.assertEqual(exp["ended_at"], T0 + 2000)
        self.assertEqual(exp["end_evidence"], "coordination.finished_at")
        self.assertEqual(exp["rows_source"], "live shard-status counters")
        self.assertEqual(exp["progress"]["in_progress"], 2)
        self.assertEqual(exp["outcomes"]["INFRA"], 0)
        self.assertIn("final result.json absent", exp["state_reason"])
        exports = next(i for i in exp["lifecycle"] if i["label"] == "Evidence exports verified")
        self.assertEqual(exports["state"], "ok")
        self.assertEqual(before, {str(p): p.read_bytes() for p in admission.rglob("*.json")})

    def test_live_counter_unknown_outcome_renders_a_count_without_invented_names(self):
        # 2026-10-20 Polar batch 1 (adopted): a failed job with no verdict and unknown infra
        # (j0003) became a nameless counter row; --text crashed joining [None].
        admission = self.f.sharded(live=True)
        status = admission / "shard-01/run/shard-status.json"
        value = json.loads(status.read_text())
        value["infra"]["progress"]["combos"] = [["passed", "PASSED", False, 1], ["failed", None, None, 1]]
        status.write_text(json.dumps(value))
        data = render(admission, self.f)
        exp = data["experiment"]
        self.assertEqual((exp["unknown_count"], exp["unknown_jobs"]), (1, []), "no invented job names")
        text = CARD["render_text"](data)
        self.assertIn("No recorded task result: 1 job (names unavailable from live counters).", text)
        self.assertNotIn("None", text)
        document = self.valid(data)
        self.assertIn("No recorded task result: 1 job", document)
        named = CARD["finish_experiment"](dict(CARD["empty_experiment"]("campaign", self.tmp), scheduled_total=8, rows=[
            {"status": "failed", "task_status": None, "infra_failure": None, "task": f"t{i}"} for i in range(7)]
            + [{"status": "failed", "task_status": None, "infra_failure": None}]))
        self.assertEqual((named["unknown_count"], named["unknown_jobs"]), (8, ["t0", "t1", "t2", "t3", "t4", "t5"]))
        self.assertIn({"severity": "amber", "text": "No recorded task result: 8 jobs (t0, t1, t2, t3, t4, t5, +2 more).",
                       "owner": "parent", "action": "/RCA from the job log and controller receipts"}, CARD["_issues"](named))

    def test_missing_data_renders_explicit_states(self):
        empty = self.tmp / "empty"
        empty.mkdir()
        data = CARD["build"](empty, ledger=self.tmp / "none.jsonl", now=NOW)
        text = CARD["render_text"](data)
        for state in ("UNRECORDED", "UNMEASURED", "UNMETERED", "experiments/day UNRECORDED (no ledger launch)"):
            self.assertIn(state, text)
        self.valid(data)
        run = self.tmp / "20261018-192852-1"
        write(run / "_batch/report-card.json", card(run.name, [task("alpha", "running", stage="running", cost=None, duration=None)], cost=False))
        data = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)
        exp = data["experiment"]
        self.assertEqual((exp["state"], exp["terminal_attempts"], exp["cost"]["metered_usd"]), ("RUNNING", 0, None))
        document = self.valid(data)
        self.assertIn("NO TERMINAL ATTEMPTS", document)
        self.assertIsNone(CARD["SENTINEL"].search(" ".join(re.sub(r"<script.*?</script>|<style.*?</style>|<[^>]+>", " ", document, flags=re.S).split())))

    def test_fleet_startup_card_lists_starting_tasks(self):
        run = self.tmp / "20261018-192852-2"
        starting = [{"name": n, "status": "starting", "phase": "verifying environment"} for n in ("alpha", "beta")]
        write(run / "_batch/report-card.json", {"run_id": run.name, "timestamp": "2026-10-18T19:28:52+00:00",
                                               "status": "starting", "phase": "verifying environment",
                                               "summary": {"total": 2, "passed": 0, "failed": 0},
                                               "tasks": starting, "per_task": starting})
        data = CARD["build"](run, ledger=self.tmp / "none.jsonl", now=NOW)
        self.assertEqual((data["experiment"]["scheduled_total"], data["experiment"]["state"]), (2, "RUNNING"))
        self.valid(data)

    def test_monitor_observation_time_respects_daylight_saving(self):
        monitor = runpy.run_path(str(ROOT / "scripts/cloudbench-monitor.py"), run_name="monitor")
        write(self.tmp / "_batch/report-card.json", {"per_task": []})
        for instant, label in ((T0, "Oct 18, 12:28:52 PM PDT"), (T0 + 55 * 86400, "Dec 12, 11:28:52 AM PST")):
            class Fixed(monitor["datetime"]):
                @classmethod
                def now(cls, tz=None, instant=instant):
                    return monitor["datetime"].fromtimestamp(instant, tz)
            with mock.patch.dict(monitor["observe"].__globals__, {"datetime": Fixed}):
                self.assertEqual(monitor["observe"](self.tmp)["timestamp_pst"], label)

    def test_pacific_time_respects_daylight_saving(self):
        pacific = CARD["pacific"]
        self.assertEqual(pacific(T0), "Oct 18, 12:28:52 PM PDT")
        self.assertEqual(pacific(1768521600), "Jan 15, 4:00:00 PM PST")  # 2026-01-16 00:00 UTC
        self.assertEqual(pacific(1772964000 - 1), "Mar 8, 1:59:59 AM PST")  # spring forward 2026-03-08 10:00 UTC
        self.assertEqual(pacific(1772964000), "Mar 8, 3:00:00 AM PDT")
        self.assertEqual(pacific(1793523600 - 1), "Nov 1, 1:59:59 AM PDT")  # fall back 2026-11-01 09:00 UTC
        self.assertEqual(pacific(1793523600), "Nov 1, 1:00:00 AM PST")
        self.assertEqual(pacific(1792393200), "Oct 19, 12:00:00 AM PDT")  # midnight is 12 AM, never 00
        self.assertEqual(pacific(None), "UNRECORDED")

    def test_validator_rejects_noncompliant_cards(self):
        document = self.valid(render(self.f.fleet(), self.f))
        hand = '<!doctype html><html><body><pre>🧪 EXPERIMENT #6 PASS 4 HARNESS 0 INFRA 0</pre></body></html>'
        self.assertIn("hand-written cards are non-compliant", " ".join(CARD["validate_html"](hand)))
        cases = {
            "null sentinel": document.replace("Triggered", "Triggered null", 1),
            "em dash": document.replace("Lifecycle</h2>", "Lifecycle —</h2>", 1),
            "fixed width": document.replace("main{max-width:760px", "main{width:800px;max-width:760px", 1),
            "remote": document.replace("</main>", '<img src="https://example.com/x.png"></main>', 1),
            "section": document.replace('data-section="issues"', 'data-section="other"', 1),
        }
        for name, bad in cases.items():
            with self.subTest(name):
                self.assertTrue(CARD["validate_html"](bad), name)

    def test_markup_is_360px_safe(self):
        document = self.valid(render(self.f.sharded(), self.f))
        css = re.search(r"<style>(.*?)</style>", document, re.S).group(1)
        widths = [float(v) for v in re.findall(r"(?<![-\w])(?:min-)?width\s*:\s*(\d+(?:\.\d+)?)px", css)]
        self.assertTrue(all(w <= 360 for w in widths), widths)
        self.assertIn("max-width:760px", css)
        self.assertIn('name="viewport"', document)
        self.assertNotIn("vh", re.sub(r"[a-z]vh|vh[a-z]", "", css))

    def test_blocking_agent_moves_section_above_history(self):
        agents = [{"name": "rca-timeout", "work": "480s cutoff", "blocking": True, "status": "⛔", "tokens": 1250000,
                   "warming_s": 420, "started_at": NOW - 3000, "blocker": "needs approval", "action": "parent delivers packet"},
                  {"name": "monitor", "status": "🔄", "tokens": None, "life_s": 600}]
        document = self.valid(render(self.f.fleet(), self.f, agents=agents))
        self.assertLess(document.index('data-section="agents"'), document.index('data-section="history"'))
        self.assertIn("warming 7m00s", document)
        self.assertIn("needs approval", document)
        self.assertIn("UNMETERED", document)
        relaxed = self.valid(render(self.f.fleet(), self.f, agents=[dict(agents[1])]))
        self.assertGreater(relaxed.index('data-section="agents"'), relaxed.index('data-section="history"'))

    def test_cli_html_text_json_and_validate(self):
        run = self.f.fleet()
        out = self.tmp / "card/index.html"
        env = dict(os.environ, CLOUDBENCH_EXPERIMENTS_LEDGER=str(self.f.ledger))
        cli = ["bash", str(ROOT / "scripts/run-bench"), "scorecard"]
        made = subprocess.run(cli + [str(run), "--html", str(out), "--json"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(made.returncode, 0, made.stderr)
        self.assertTrue(json.loads(made.stdout.splitlines()[0])["valid"])
        checked = subprocess.run(cli + ["--validate", str(out)], capture_output=True, text=True, timeout=60)
        self.assertEqual((checked.returncode, json.loads(checked.stdout)["valid"]), (0, True))
        hand = write(self.tmp / "hand.html", "<html><body>card</body></html>")
        self.assertEqual(subprocess.run(cli + ["--validate", str(hand)], capture_output=True, timeout=60).returncode, 1)
        text = subprocess.run(cli + [str(run), "--text"], capture_output=True, text=True, env=env, timeout=60)
        self.assertTrue(text.stdout.startswith("🧪 EXPERIMENT #1"), text.stdout[:200])


class NativeReleaseAuditOwnership(unittest.TestCase):
    """2026-10-19 polar70: three retained guests stayed started while the audit said released.

    Their fleets ended with ``cleanup_policy=retain``. Each primary was recorded only in its
    run's ``primary.ids``, its exported git-common ownership registry/audit and the guest's
    native ``CLOUDBENCH_RUN_TOKEN``; none of those were read, so ``present`` stayed empty.
    """

    RELEASED, RETAINED = "1f" * 16, "dc" * 16

    def admission(self, base: Path) -> Path:
        admission = base / "original600-1792440129763435696"
        write(admission / "coordination.json", {"controllers": 1})
        export = admission / "shard-00/run/export"
        write(export / "disposable-export.verified.json", "{}")
        members = {
            # A fully released fleet: teardown moved its audit into the run directory.
            "context/fleet/runs/20261019-201626-26082/teardown-ownership/owned-clones.ids": "847559f2e20318\n",
            "context/fleet/runs/20261019-201626-26082/teardown-ownership/owned-clones.names": "cloudbench-aaaa\n",
            f"git-common/cloudbench-fleet-audits/{self.RELEASED}/meta":
                f"fleet_owner_token={self.RELEASED}\nstatus=provider-teardown-verified\n",
            # The retained fleet: guest cleanup unconfirmed, ownership left in git-common.
            "context/fleet/runs/20261019-201626-26147/teardown-ownership.path":
                f"/tmp/gate/repo/.git/cloudbench-fleet-audits/{self.RETAINED}",
            "context/fleet/runs/20261019-201626-26147/polar-odysseys-a24232e8f6e7/primary.ids": "8ed954ef9d2138\n",
            f"git-common/cloudbench-fleet-ownership/{self.RETAINED}/meta":
                f"version=2\napp=navi-whisper-lux-bench\nfleet_owner_token={self.RETAINED}\n"
                "run_id=20261019-201626-26147\ncleanup_policy=retain\n",
            f"git-common/cloudbench-fleet-ownership/{self.RETAINED}/guest-cleanup-unconfirmed": "",
            f"git-common/cloudbench-fleet-ownership/{self.RETAINED}/clones/cloudbench-774d3d3f3cc54c569a86cff6":
                "name=cloudbench-774d3d3f3cc54c569a86cff6\nid=8ed954ef9d2138\nvolume_id=vol_4m3mqdlj75d6901v\n",
            f"git-common/cloudbench-fleet-audits/{self.RETAINED}/meta":
                f"fleet_owner_token={self.RETAINED}\nstatus=incomplete\n",
        }
        with tarfile.open(export / "originals.tar.gz", "w:gz") as stream:
            for name, text in members.items():
                data = text.encode()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                stream.addfile(info, io.BytesIO(data))
        return admission

    @staticmethod
    def api(machines, volumes):
        class Api:
            def api(self, method, path, timeout):
                assert method == "GET"
                return volumes if path.startswith("/volumes") else machines
        return Api()

    def guest(self, mid, name, token, volume):
        return {"id": mid, "name": name, "state": "started",
                "config": {"env": {"CLOUDBENCH_RUN_TOKEN": token + "-0", "UNRELATED_SECRET": "never-recorded"},
                           "mounts": [{"volume": volume}]}}

    def test_retained_owner_guests_and_volumes_are_found_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as name:
            admission = self.admission(Path(name))
            machines = [
                self.guest("8ed954ef9d2138", "cloudbench-774d3d3f3cc54c569a86cff6", self.RETAINED, "vol_4m3mqdlj75d6901v"),
                # A sibling guest of the same owner whose ID was never written to any export file.
                self.guest("e82037df15e468", "cloudbench-bdad8546e65142dd8267b1da", self.RETAINED, "vol_r7ymxn76780g71gr"),
                # Protected warm donor and another owner's guest: never matched.
                {"id": "8ed16dc75ee958", "name": "cloudbench-warm-t10-ord-85a7e2c", "state": "stopped", "config": {"env": {}}},
                self.guest("80000000000001", "cloudbench-other", "ab" * 16, "vol_other"),
            ]
            volumes = [{"id": "vol_4m3mqdlj75d6901v", "name": "cbv_774d3d3f3cc54c569a86cff6", "state": "created"},
                       {"id": "vol_r7ymxn76780g71gr", "name": "cbv_bdad8546e65142dd8267b1da", "state": "created"},
                       {"id": "vol_other", "name": "cbv_other", "state": "created"}]
            result = AUDIT["run"](admission, self.api(machines, volumes), "navi-whisper-lux-bench")
            self.assertFalse(result["released"], "a live retained guest never certifies release")
            self.assertEqual(sorted(m["id"] for m in result["present"]), ["8ed954ef9d2138", "e82037df15e468"])
            self.assertEqual(sorted(v["id"] for v in result["present_volumes"]),
                             ["vol_4m3mqdlj75d6901v", "vol_r7ymxn76780g71gr"])
            self.assertEqual(result["retained_owners"], [self.RETAINED])
            self.assertNotIn("never-recorded", json.dumps(result), "the audit never records guest environment values")
            saved = json.loads((admission / "native-release-audit.json").read_text())
            self.assertFalse(saved["released"])

            # Native absence alone does not discharge an exported owner that never retired.
            absent = AUDIT["run"](admission, self.api([machines[2]], []), "navi-whisper-lux-bench")
            self.assertEqual((absent["present"], absent["present_volumes"]), ([], []))
            self.assertFalse(absent["released"], "a retained ownership registry fails closed")
            self.assertTrue(AUDIT["audit"]([], app="app", guest_names={"cloudbench-a"}, guest_ids=set(), controllers=set(),
                                           exports=1, shards=1, now=T0)["released"])

    def test_retried_shard_counts_only_its_final_attempt_export(self):
        with tempfile.TemporaryDirectory() as name:
            admission = self.admission(Path(name))
            retained = admission / "shard-00/run/export/originals.tar.gz"
            # The released fleet alone, in the shard's first attempt and in shard-01.
            for target in (admission / "shard-00/run/export", admission / "shard-01/run/export"):
                write(target / "disposable-export.verified.json", "{}")
                with tarfile.open(target / "originals.tar.gz", "w:gz") as stream:
                    data = b"847559f2e20318\n"
                    info = tarfile.TarInfo("context/fleet/runs/20261019-201626-26082/teardown-ownership/owned-clones.ids")
                    info.size = len(data)
                    stream.addfile(info, io.BytesIO(data))
            final = admission / "shard-01/attempt-02/run"
            final.mkdir(parents=True)
            write(admission / "coordination.json", {"controllers": 2, "shards": {
                "0": {"out": str(admission / "shard-00/run")}, "1": {"out": str(final)}}})
            result = AUDIT["run"](admission, self.api([], []), "app")
            self.assertEqual(result["checked"]["verified_exports"], 1, "shard-01's final attempt exported nothing")
            self.assertFalse(result["released"], "an earlier attempt's export never stands in for the final one")
            write(final / "export/disposable-export.verified.json", "{}")
            (final / "export/originals.tar.gz").write_bytes((admission / "shard-01/run/export/originals.tar.gz").read_bytes())
            result = AUDIT["run"](admission, self.api([], []), "app")
            self.assertEqual((result["checked"]["verified_exports"], result["checked"]["expected_shards"]), (2, 2))
            self.assertTrue(result["released"], "every final export checked, nothing present, no retained owner")
            self.assertTrue(retained.exists())


class LaunchInstructions(unittest.TestCase):
    def test_instruction_names_the_exact_render_and_publish_commands(self):
        printed = StringIO()
        with redirect_stdout(printed):
            CARD["print_instruction"]("/runs/abc")
        text = printed.getvalue()
        for needle in ("scripts/run-bench scorecard /runs/abc --html /runs/abc/scorecard.html",
                       "dvb-onbox visuals publish --file /runs/abc/scorecard.html",
                       "hand-written cards are non-compliant", "every 15 minutes", "state change", "completion"):
            self.assertIn(needle, text)

    def test_every_launch_path_prints_the_scorecard_command(self):
        fleet = (ROOT / "scripts/run-bench-fleet").read_text()
        self.assertIn('cloudbench-scorecard.py" --instruction "$FLEET_DIR"', fleet)
        self.assertEqual(fleet.count("fleet_scorecard_report launch"), 1)
        self.assertIn("fleet_scorecard_report end", fleet)
        campaign = (ROOT / "scripts/run-bench-campaign.py").read_text()
        self.assertEqual(campaign.count('scorecard["print_instruction"](campaign_dir)'), 2, "campaign start and end")
        operator = (ROOT / "scripts/run-original600-controller.py").read_text()
        self.assertEqual(operator.count("scorecard['print_instruction'](directory)"), 2, "operator start and end")
        local = (ROOT / "agents/benchmarks/local.py").read_text()
        self.assertEqual(local.count("print_scorecard_instruction(_dashboard_context_dir(stack))"), 2, "local start and end")
        contract = (ROOT / ".claude/shared/benchmark-report-format.txt").read_text()
        self.assertIn("FORMAT v8", contract)
        self.assertIn("scripts/run-bench scorecard <run-dir> --html", contract)
        self.assertIn("non-compliant", contract)

    def test_fleet_report_hook_records_standalone_launches_only(self):
        source = (ROOT / "scripts/run-bench-fleet").read_text()
        body = source[source.index("fleet_scorecard_report() {"):source.index("fleet_scorecard_report launch\n")]
        with tempfile.TemporaryDirectory() as name:
            base = Path(name)
            (base / "scripts").mkdir()
            for script in ("cloudbench-scorecard.py", "cloudbench_experiments.py"):
                shutil.copy2(ROOT / "scripts" / script, base / "scripts" / script)
            harness = f'''set -euo pipefail
ROOT_DIR={base}; FLEET_DIR={base}/run; RUN_ID=20261018-1-7; GIT_COMMON_DIR={base}; PROVISION_POOL=""
BENCHES=(alpha beta)
{body}
fleet_scorecard_report launch
RUN_BENCH_CAMPAIGN_CHILD=1 RUN_ID=child fleet_scorecard_report launch
fleet_scorecard_report end ENDED
'''
            done = subprocess.run(["bash", "-c", harness], capture_output=True, text=True, timeout=60,
                                  env={k: v for k, v in os.environ.items() if k not in ("CLOUDBENCH_EXPERIMENTS_LEDGER", "RUN_BENCH_CAMPAIGN_CHILD")})
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stdout.count("scripts/run-bench scorecard"), 6, "every hook call prints the command")
            entries = LEDGER["read"](base / "cloudbench-experiments.jsonl")
            self.assertEqual([(e["event"], e["id"]) for e in entries], [("launch", "20261018-1-7"), ("end", "20261018-1-7")])
            self.assertEqual((entries[0]["goal"], entries[0]["slice"], entries[0]["scheduled_total"]), ("fleet:alpha,beta", "alpha +1", 2))

    def test_campaign_hooks_skip_sharded_children(self):
        module = runpy.run_path(str(ROOT / "scripts/run-bench-campaign.py"))
        hooks = module["scorecard_hooks"]()
        self.assertIsNotNone(hooks)
        with tempfile.TemporaryDirectory() as name:
            ledger = Path(name) / "ledger.jsonl"
            env = dict(os.environ, CLOUDBENCH_EXPERIMENTS_LEDGER=str(ledger))
            env.pop("RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER", None)
            with mock.patch.dict(os.environ, env, clear=True):
                module["record_experiment"](hooks, "launch", Path(name) / "campaign-a", ROOT, goal="g")
                os.environ["RUN_BENCH_CAMPAIGN_EXTERNAL_BARRIER"] = "/barrier"
                module["record_experiment"](hooks, "launch", Path(name) / "campaign-b", ROOT, goal="g")
            self.assertEqual([e["id"] for e in LEDGER["read"](ledger)], ["campaign-a"])


class ExperimentsLedger(unittest.TestCase):
    def test_append_only_idempotent_numbered_per_goal(self):
        with tempfile.TemporaryDirectory() as name:
            ledger = Path(name) / "l.jsonl"
            for ident, goal, at in (("a", "g1", T0), ("b", "g2", T0 + 10), ("c", "g1", T0 + 20)):
                LEDGER["record"]("launch", ident, ledger=ledger, goal=goal, triggered_at=at)
            LEDGER["record"]("launch", "a", ledger=ledger, goal="g1", triggered_at=T0 + 999)
            LEDGER["record"]("end", "a", ledger=ledger, goal="g1", ended_at=T0 + 5)
            with ledger.open("a") as stream:
                stream.write("{not json\n")
            entries = LEDGER["read"](ledger)
            self.assertEqual(len(entries), 4, "duplicates are not appended and malformed lines are skipped")
            g1 = LEDGER["experiments"](entries, "g1")
            self.assertEqual([(e["id"], e["number"], e["triggered_at"]) for e in g1], [("a", 1, T0), ("c", 2, T0 + 20)])
            self.assertEqual(g1[0]["end"]["ended_at"], T0 + 5)
            rate = LEDGER["launch_rate"](g1, T0 + 43200)
            self.assertEqual((rate["launches"], round(rate["days"], 2), round(rate["per_day"], 1)), (2, 0.5, 4.0))
            early = LEDGER["launch_rate"](g1, T0 + 30)
            self.assertEqual(early["per_day"], 5760.0, "use the actual 30 seconds, not a synthetic minute")
            zero = LEDGER["launch_rate"](g1[:1], T0)
            self.assertIsNone(zero["per_day"], "no rate can be inferred at zero elapsed time")
            self.assertIn("no elapsed goal time", CARD["_rate_text"]({"rate": zero, "generated_at": T0}))

    def test_oversized_entry_drops_optional_fields_and_never_writes_partial_line(self):
        with tempfile.TemporaryDirectory() as name:
            ledger = Path(name) / "l.jsonl"
            bulky = {f"field_{i:02d}": "y" * 300 for i in range(20)}
            first = LEDGER["record"]("launch", "big", ledger=ledger, goal="g", triggered_at=T0,
                                     notes="n" * 300, outcome="o" * 300, **bulky)
            self.assertIsNotNone(first)
            LEDGER["record"]("end", "big", ledger=ledger, goal="g", ended_at=T0 + 5)
            raw = ledger.read_bytes()
            self.assertTrue(raw.endswith(b"\n"))
            lines = raw.splitlines()
            self.assertEqual(len(lines), 2, "the next append stays on its own line")
            self.assertTrue(all(len(line) + 1 <= LEDGER["MAX_LINE_BYTES"] for line in lines))
            entries = LEDGER["read"](ledger)
            self.assertEqual([(e["event"], e["id"]) for e in entries], [("launch", "big"), ("end", "big")])
            launch = entries[0]
            self.assertEqual((launch["goal"], launch["triggered_at"]), ("g", T0))
            self.assertNotIn("notes", launch)
            self.assertNotIn("outcome", launch)
            self.assertTrue(any(key.startswith("field_") for key in launch), "only enough optional fields are dropped")
            g = LEDGER["experiments"](entries, "g")
            self.assertEqual((len(g), g[0]["number"], g[0]["end"]["ended_at"]), (1, 1, T0 + 5))

    def test_concurrent_processes_append_complete_lines(self):
        with tempfile.TemporaryDirectory() as name:
            ledger = Path(name) / "l.jsonl"
            code = ("import runpy,sys;m=runpy.run_path(sys.argv[1]);"
                    "[m['record']('launch',f'{sys.argv[3]}-{i}',ledger=__import__('pathlib').Path(sys.argv[2]),goal='g',notes='x'*900) for i in range(25)]")
            procs = [subprocess.Popen([sys.executable, "-c", code, str(ROOT / "scripts/cloudbench_experiments.py"), str(ledger), str(n)])
                     for n in range(4)]
            self.assertEqual([p.wait(timeout=60) for p in procs], [0] * 4)
            lines = ledger.read_text().splitlines()
            self.assertEqual(len(lines), 100)
            self.assertTrue(all(json.loads(line)["schema"] == "cloudbench-experiment-v1" for line in lines))

    def test_backfill_reads_only_existing_admission_receipts(self):
        with tempfile.TemporaryDirectory() as name:
            fixtures = Fixtures(Path(name))
            admission = fixtures.sharded()
            write(admission / "result.json", {"task_status": {"PASSED": 2, "FAILED": 2}, "infra_failures": 0,
                                              "observed_jobs": 4, "missing_jobs": 0})
            entries = LEDGER["original600_entries"](admission, "goal")
            self.assertEqual([e for e, _ in entries], ["launch", "end"])
            self.assertEqual((entries[0][1]["triggered_at"], entries[0][1]["backfilled"]), (T0, True))
            self.assertEqual((entries[1][1]["ended_at"], entries[1][1]["state"]), (T0 + 2000, "COMPLETE"))
            never = Path(name) / "never-launched"
            never.mkdir()
            self.assertEqual(LEDGER["original600_entries"](never, "goal"), [], "an admission without coordination never launched")


if __name__ == "__main__":
    unittest.main()
